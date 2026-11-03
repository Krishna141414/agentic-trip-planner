"""Tiny wrapper around the local Qwen2.5-0.5B-Instruct model (CPU, offline, no API key).

The model is loaded lazily on first use, so the web page opens instantly.
"""
import json
import os
import re
import threading

os.environ.setdefault("HF_HUB_OFFLINE", "1")  # never download: use the model already in the HF cache

MODEL_ID = "Qwen/Qwen2.5-0.5B-Instruct"
_model = _tok = None
_lock = threading.Lock()  # one generation at a time (CPU)


def _load():
    global _model, _tok
    if _model is None:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
        torch.set_num_threads(max(1, (os.cpu_count() or 2) - 1))
        _tok = AutoTokenizer.from_pretrained(MODEL_ID, local_files_only=True)
        _model = AutoModelForCausalLM.from_pretrained(MODEL_ID, local_files_only=True, dtype=torch.float32)
        _model.eval()
    return _model, _tok


def is_loaded() -> bool:
    return _model is not None


def chat(system: str, user: str, max_new_tokens: int = 200) -> str:
    """Greedy (deterministic) generation from a system + user message."""
    import torch
    with _lock:
        model, tok = _load()
        msgs = [{"role": "system", "content": system}, {"role": "user", "content": user}]
        ids = tok.apply_chat_template(msgs, add_generation_prompt=True, return_tensors="pt", return_dict=True)
        with torch.no_grad():
            out = model.generate(**ids, max_new_tokens=max_new_tokens, do_sample=False,
                                 pad_token_id=tok.eos_token_id)
        return tok.decode(out[0][ids["input_ids"].shape[1]:], skip_special_tokens=True).strip()


def extract_json(text: str):
    """Pull the first JSON object/array out of model text; None if there isn't valid JSON."""
    text = re.sub(r"```(?:json)?", "", text)
    for opener, closer in (("{", "}"), ("[", "]")):
        start, end = text.find(opener), text.rfind(closer)
        if start != -1 and end > start:
            try:
                return json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                continue
    return None
