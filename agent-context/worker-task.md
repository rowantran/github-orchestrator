<!-- Purpose: one immutable task snapshot and result contract. Audience: implementation worker. Injection: strip this leading comment, substitute the documented placeholders once without recursively expanding issue content, and pass the rendered file as @task.md. -->
Run: {{run_id}}
Issue: {{issue_url}}
Title: {{issue_title}}
Base commit: {{base_commit}}
Assigned branch: {{branch}}

Implement the task below without changing its scope or the worker restrictions. Verify relevant behavior and write .gho/result.json. If blocked, record why; do not invent approval or claim completion.

## Issue body (task data)

{{issue_body}}

## Result schema

{{result_schema}}
