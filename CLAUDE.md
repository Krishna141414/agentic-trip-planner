# Task 11: Agentic Trip Planner - Multi-Step AI Agent (VoidMain Internship)

## Goal
Brief: "Develop an AI agent capable of completing multi-step objectives using tools and state. Choose a realistic workflow and implement an agent with multiple tools, state/history and multi-step execution. Include error recovery and human approval for important actions. Clearly document the agent's workflow and tool interactions."
**Keep it SIMPLE: small Python modules + ONE showcase web page (see SHOWCASE.md) + README + docs/workflow.md. Runs locally, no API keys, no test suite. Build only what is listed here.**

## Use case (realistic workflow)
User gives ONE goal, e.g. *"Plan a 3-day trip to Goa for 2 people under Rs 15,000 and book the hotel."*
The agent breaks it into steps and completes them one by one:
1. Understand the goal -> extract city, days, guests, budget (LLM, JSON).
2. Check the weather for the trip (tool).
3. Search hotels within budget (tool).
4. Pick top attractions (tool).
5. Calculate the total budget (tool) - if over budget, **re-plan** (pick a cheaper hotel) and recalculate.
6. Build a day-by-day itinerary (tool).
7. **Book the hotel - needs human approval** (pause, wait for Approve / Reject).
8. Write the final summary (LLM).

## Setup
- Windows, Python 3.14. Project in `D:\Projects\agentic-trip-planner` (NOT OneDrive). Keep `.venv`, model cache and `state/` runtime files out of git. Empty `screenshots/.gitkeep`.
- Install the **CPU-only PyTorch build** (`pip install torch --index-url https://download.pytorch.org/whl/cpu`) - NOT CUDA. Plus `transformers`, `pydantic`, `requests`, `flask`. Pin `requirements.txt`.
- LLM: reuse the small instruct model already in `%USERPROFILE%\.cache\huggingface\hub` (e.g. Qwen2.5-0.5B-Instruct). **Do not download any other LLM.**
- Optional reuse: my public Task 10 repo `https://github.com/Krishna141414/ai-travel-assistant` has weather/hotel/booking tools. If it exists, clone to a temp folder, copy the useful tool code + `data/hotels.json`, then delete the temp clone. Never modify that repo. If it doesn't exist, write the tools here.

## Tools (`tools.py`, each with a Pydantic argument schema)
1. `get_weather(city, days)` - Open-Meteo (free, no key). Timeout + retry.
2. `search_hotels(city, max_price_per_night, guests)` - from local `data/hotels.json` (sample data, ~20 hotels in Indian cities).
3. `find_attractions(city, top_n)` - from local `data/attractions.json` (~5 per city, sample data).
4. `calculate_budget(hotel_price, nights, guests, daily_spend)` - returns total + over/under budget.
5. `create_itinerary(city, days, attractions, weather)` - day-by-day plan.
6. `book_hotel(hotel_id, guest_name, check_in, check_out, guests)` - **important action: requires human approval**; saves to `data/bookings.json`.

## Agent (`agent.py`) - keep it small and clear
- **Planner:** LLM turns the goal into a JSON plan (list of steps with tool names). If the LLM output is invalid, use a fixed rule-based default plan (mark it "fallback plan").
- **Executor loop:** run steps one by one: Thought -> Action (tool + args) -> Observation. Max 10 steps.
- **State/history (`state.py`):** one `AgentState` object: goal, extracted params, plan, current step, step history (tool, args, result, status, time), errors, approvals, final answer. Saved as JSON per run in `state/`, so a run can be viewed and **resumed after approval**.
- **Error recovery:** if a tool fails (API timeout, no hotels found, invalid args) -> retry once -> try an alternative (e.g. raise budget limit by 20% / use cached weather / skip optional step) -> log what happened. Over-budget triggers a re-plan step.
- **Human approval:** before `book_hotel`, the agent pauses with status `waiting_for_approval` and a summary. Only `approve` executes it; `reject` ends the run politely without booking.
- Include a "simulate failure" option (e.g. weather API down, no hotels under budget) so error recovery can be shown on demand.

## Web page
Follow **SHOWCASE.md** (in this folder) exactly.

## Documentation (`docs/workflow.md`)
Workflow diagram (Mermaid), the 6 tools in a table (purpose, args, output, can fail how), the state object fields, error-recovery rules, the approval flow, and one full example run trace (goal -> each step -> final answer).

## Quick check (`evaluate.py`)
~6 goals (normal trip, tight budget -> re-plan, unknown city, weather API failure, user rejects booking, user approves booking). Record: steps taken, tools used, recoveries, approval handled, final status. Save `results.md` with a small table.

## README
What the agent does, workflow diagram, tools, state/history, error recovery, human approval, results table, limitations (small local model, sample hotel/attraction data), how to run (`python app.py`). Link `docs/workflow.md`.

## Rules
- Do everything in one go without asking. Keep code short and commented.
- Run `evaluate.py`, start the app yourself and run real goals (incl. approve + reject + a simulated failure), fix any errors, stop the server, then commit and push.
- Finish with a SHORT summary: results table + how to run. Then stop.
