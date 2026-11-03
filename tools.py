"""The 6 agent tools. Each tool = Pydantic argument schema + a plain function.

Tools never "fix" bad input themselves: they raise ToolError(kind=...) and the
agent decides how to recover (retry, alternative, skip). Weather/hotel helpers
are adapted from the Task 10 repo (ai-travel-assistant).
"""
import contextvars
import json
from datetime import date, timedelta
from pathlib import Path

import requests
from pydantic import BaseModel, Field, field_validator

DATA = Path(__file__).parent / "data"
BOOKINGS_PATH = DATA / "bookings.json"  # runtime file (git-ignored)
TIMEOUT = 6

# Failure simulation for demos, set per run (thread-safe via contextvars):
# {"flags": {"weather_down" | "no_hotels" | "bad_args"}, "hotel_calls": 0}
SIMULATE: contextvars.ContextVar[dict] = contextvars.ContextVar("simulate", default={"flags": set()})

WEATHER_CODES = {0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "fog",
                 51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 61: "light rain", 63: "rain",
                 65: "heavy rain", 71: "light snow", 73: "snow", 75: "heavy snow", 80: "rain showers",
                 81: "rain showers", 82: "violent showers", 95: "thunderstorm", 96: "thunderstorm", 99: "thunderstorm"}


class ToolError(Exception):
    """Readable tool failure. kind tells the agent which recovery to try:
    transient (API down/timeout), not_found (unknown city), no_match (nothing under budget)."""

    def __init__(self, message: str, kind: str = "transient"):
        super().__init__(message)
        self.kind = kind


def _load(name: str) -> dict:
    return json.loads((DATA / name).read_text(encoding="utf-8"))


def _get_json(url: str, params: dict) -> dict:
    """One HTTP GET with timeout (the agent does the retry, so it is visible in the trace)."""
    try:
        r = requests.get(url, params=params, timeout=TIMEOUT)
        r.raise_for_status()
        return r.json()
    except requests.RequestException as e:
        raise ToolError(f"weather API unavailable ({type(e).__name__})", "transient")


# ---------- argument schemas ----------
class WeatherArgs(BaseModel):
    city: str = Field(min_length=2, max_length=60)
    days: int = Field(ge=1, le=9)
    start_date: date | None = None  # trip start; default = today


class HotelSearchArgs(BaseModel):
    city: str = Field(min_length=2, max_length=60)
    max_price_per_night: float = Field(gt=0)
    guests: int = Field(ge=1, le=10)


class AttractionArgs(BaseModel):
    city: str = Field(min_length=2, max_length=60)
    top_n: int = Field(default=5, ge=1, le=10)


class BudgetArgs(BaseModel):
    hotel_price: float = Field(gt=0)
    nights: int = Field(ge=1, le=30)
    guests: int = Field(ge=1, le=10)
    daily_spend: float = Field(ge=0, description="food + transport + entry fees per person per day")
    budget: float = Field(gt=0)


class ItineraryArgs(BaseModel):
    city: str
    days: int = Field(ge=1, le=14)
    attractions: list[dict]
    weather: list[dict] = []  # may be empty if the weather step was skipped


class BookArgs(BaseModel):
    hotel_id: str
    guest_name: str = Field(min_length=2, max_length=60)
    check_in: date
    check_out: date
    guests: int = Field(ge=1, le=10)

    @field_validator("hotel_id")
    @classmethod
    def hotel_id_format(cls, v: str) -> str:
        v = v.strip().upper()
        if not (len(v) == 3 and v[0] == "H" and v[1:].isdigit()):
            raise ValueError("must look like H05")
        return v


# ---------- tools ----------
def get_weather(a: WeatherArgs) -> dict:
    """Live forecast from Open-Meteo (free, no key) for the trip dates."""
    if "weather_down" in SIMULATE.get()["flags"]:
        _get_json("http://127.0.0.1:9/v1/forecast", {})  # dead address -> ToolError (simulated outage)
    known = _load("weather_cache.json")["cities"].get(a.city.strip().title())
    if known:  # fixed coordinates for our cities (geocoding "Goa" returns Genoa / a village in Rajasthan)
        place = {"name": a.city.strip().title(), "latitude": known["lat"], "longitude": known["lon"]}
    else:
        geo = _get_json("https://geocoding-api.open-meteo.com/v1/search",
                        {"name": a.city, "count": 1, "language": "en", "countryCode": "IN"})
        if not geo.get("results"):
            raise ToolError(f"city '{a.city}' was not found by the weather service", "not_found")
        place = geo["results"][0]
    start = a.start_date or date.today()
    offset = max(0, (start - date.today()).days)
    fc = _get_json("https://api.open-meteo.com/v1/forecast", {
        "latitude": place["latitude"], "longitude": place["longitude"], "timezone": "auto",
        "forecast_days": min(16, offset + a.days),
        "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code"})
    d = fc["daily"]
    days = [{"date": d["time"][i], "min_c": d["temperature_2m_min"][i], "max_c": d["temperature_2m_max"][i],
             "rain_chance_pct": d["precipitation_probability_max"][i] or 0,
             "condition": WEATHER_CODES.get(d["weather_code"][i], "unknown")}
            for i in range(offset, len(d["time"]))][: a.days]
    return {"city": place["name"], "source": "Open-Meteo (live)", "days": days}


def cached_weather(a: WeatherArgs) -> dict:
    """Fallback used by the agent when the live API fails: typical climate table."""
    c = _load("weather_cache.json")["cities"].get(a.city.strip().title())
    if not c:
        raise ToolError(f"no cached climate data for '{a.city}'", "not_found")
    start = a.start_date or date.today()
    clim = {k: c[k] for k in ("min_c", "max_c", "rain_chance_pct", "condition")}
    days = [{"date": str(start + timedelta(days=i)), **clim} for i in range(a.days)]
    return {"city": a.city.title(), "source": "cached typical climate (approximate)", "days": days}


def search_hotels(a: HotelSearchArgs) -> dict:
    """Hotels in the city that fit the guests and the nightly price limit (sample data)."""
    hotels = _load("hotels.json")["hotels"]
    in_city = [h for h in hotels if h["city"].lower() == a.city.strip().lower()]
    if not in_city:
        cities = ", ".join(sorted({h["city"] for h in hotels}))
        raise ToolError(f"no hotels for '{a.city}' in our data. Available cities: {cities}", "not_found")
    sim = SIMULATE.get()
    if "no_hotels" in sim["flags"]:  # first query + its retry come back empty; the agent's alternative query works
        sim["hotel_calls"] = sim.get("hotel_calls", 0) + 1
        if sim["hotel_calls"] <= 2:
            raise ToolError(f"0 rooms available under Rs {a.max_price_per_night:,.0f}/night (simulated sold-out)", "no_match")
    match = sorted((h for h in in_city if h["max_guests"] >= a.guests and h["price_per_night"] <= a.max_price_per_night),
                   key=lambda h: (-h["rating"], h["price_per_night"]))  # best rated first
    if not match:
        cheapest = min(h["price_per_night"] for h in in_city)
        raise ToolError(f"no hotel under Rs {a.max_price_per_night:,.0f}/night for {a.guests} guests "
                        f"(cheapest in {in_city[0]['city']}: Rs {cheapest:,})", "no_match")
    return {"city": in_city[0]["city"], "count": len(match), "hotels": match, "data": "sample data"}


def find_attractions(a: AttractionArgs) -> dict:
    """Top-rated attractions for the city (sample data)."""
    data = _load("attractions.json")["attractions"]
    key = next((k for k in data if k.lower() == a.city.strip().lower()), None)
    if not key:
        raise ToolError(f"no attraction data for '{a.city}'", "not_found")
    top = sorted(data[key], key=lambda x: -x["rating"])[: a.top_n]
    return {"city": key, "count": len(top), "attractions": top}


def calculate_budget(a: BudgetArgs) -> dict:
    """Total trip cost vs. the user's budget."""
    days = a.nights + 1
    hotel_cost = round(a.hotel_price * a.nights)
    spend_cost = round(a.daily_spend * a.guests * days)
    total = hotel_cost + spend_cost
    return {"hotel_cost": hotel_cost, "daily_spend_cost": spend_cost, "total": total, "budget": round(a.budget),
            "difference": round(a.budget - total), "status": "under" if total <= a.budget else "over",
            "formula": f"{a.hotel_price:,.0f} x {a.nights} nights + {a.daily_spend:,.0f} x {a.guests} guests x {days} days"}


def create_itinerary(a: ItineraryArgs) -> dict:
    """Day-by-day plan: 2 attractions per day, indoor ones on rainy days."""
    pool = list(a.attractions)
    plan = []
    for i in range(a.days):
        w = a.weather[i] if i < len(a.weather) else None
        rainy = bool(w and w.get("rain_chance_pct", 0) >= 60)
        # rainy day -> indoor first; otherwise keep rating order
        pool.sort(key=lambda x: (not x.get("indoor"), -x["rating"]) if rainy else -x["rating"])
        picks, pool = pool[:2], pool[2:]
        slots = [{"time": t, "activity": p["name"]} for t, p in zip(["Morning", "Afternoon"], picks)]
        if len(slots) < 2:
            slots.append({"time": "Afternoon", "activity": "Free time - local market & food"})
        slots.append({"time": "Evening", "activity": "Dinner at a local favourite" if i < a.days - 1 else "Pack up & depart"})
        plan.append({"day": i + 1, "date": w["date"] if w else None,
                     "weather": f"{w['condition']}, {w['min_c']:.0f}-{w['max_c']:.0f} C, rain {w['rain_chance_pct']}%" if w else "unknown",
                     "rainy_day_plan": rainy, "slots": slots})
    return {"city": a.city, "days": plan}


def preview_booking(a: BookArgs) -> dict:
    """Validate the booking and build the approval summary (saves nothing)."""
    hotel = next((h for h in _load("hotels.json")["hotels"] if h["id"] == a.hotel_id), None)
    if not hotel:
        raise ToolError(f"hotel {a.hotel_id} does not exist", "invalid")
    if a.check_in <= date.today() or a.check_out <= a.check_in:
        raise ToolError("check-in must be in the future and before check-out", "invalid")
    if a.guests > hotel["max_guests"]:
        raise ToolError(f"{hotel['name']} fits max {hotel['max_guests']} guests", "invalid")
    nights = (a.check_out - a.check_in).days
    return {"hotel_id": hotel["id"], "hotel_name": hotel["name"], "city": hotel["city"], "area": hotel["area"],
            "guest_name": a.guest_name, "check_in": str(a.check_in), "check_out": str(a.check_out),
            "guests": a.guests, "nights": nights, "total_inr": nights * hotel["price_per_night"]}


def book_hotel(a: BookArgs) -> dict:
    """IMPORTANT ACTION - only called after human approval. Saves to data/bookings.json."""
    booking = preview_booking(a)  # re-check rules at execution time
    bookings = json.loads(BOOKINGS_PATH.read_text(encoding="utf-8")) if BOOKINGS_PATH.exists() else []
    booking = {"booking_id": f"BK{1001 + len(bookings)}", **booking, "status": "confirmed"}
    BOOKINGS_PATH.write_text(json.dumps(bookings + [booking], indent=2), encoding="utf-8")
    return booking


# Registry: the only tools the agent may call. needs_approval = pause for a human first.
TOOLS = {
    "get_weather": {"schema": WeatherArgs, "fn": get_weather, "needs_approval": False},
    "search_hotels": {"schema": HotelSearchArgs, "fn": search_hotels, "needs_approval": False},
    "find_attractions": {"schema": AttractionArgs, "fn": find_attractions, "needs_approval": False},
    "calculate_budget": {"schema": BudgetArgs, "fn": calculate_budget, "needs_approval": False},
    "create_itinerary": {"schema": ItineraryArgs, "fn": create_itinerary, "needs_approval": False},
    "book_hotel": {"schema": BookArgs, "fn": book_hotel, "needs_approval": True},
}


def run_tool(name: str, args: dict) -> dict:
    """Validate args with the tool's schema, then run it. Raises ValidationError / ToolError."""
    t = TOOLS[name]
    return t["fn"](t["schema"](**args))

