# Evaluation results

`python evaluate.py` - 6/6 cases behaved as expected. Local model: Qwen2.5-0.5B-Instruct (CPU). Hotel/attraction data is sample data.

| Case | Steps | Tools used | Recoveries | Approval | Final status | Plan | Pass | Time (s) |
|---|---|---|---|---|---|---|---|---|
| Normal trip | 8 | 5 | 0 | n/a | completed | llm plan | yes | 21.4 |
| Tight budget -> re-plan | 10 | 5 | 1 | n/a | completed | llm plan | yes | 17.4 |
| Unknown city | 4 | 2 | 1 | n/a | failed | fallback plan | yes | 7.6 |
| Weather API failure | 8 | 5 | 1 | n/a | completed | llm plan | yes | 20.9 |
| User rejects booking | 10 | 6 | 0 | paused -> reject | rejected | llm plan | yes | 18.7 |
| User approves booking | 10 | 6 | 0 | paused -> approve | completed | llm plan | yes | 19.3 |

Steps = history entries (LLM steps + tool actions + re-plans). Recoveries = retries/alternatives that saved a step, skipped optional steps, and over-budget re-plans.
