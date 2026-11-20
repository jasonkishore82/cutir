---
name: connect
description: Connect Claude to the Cutir editor, or check the connection. Use when the user wants to start working in Cutir, when a Cutir tool says it is not connected, or when they ask for the pairing code.
---

# Connect to Cutir

1. Call the `cutir_status` tool.
2. If it says **Connected**, tell the user which project is open and continue with their request.
3. If it says **not connected**, give the user these steps, using the pairing code and port from `cutir_status`:
   - Open Cutir in the browser and open a project.
   - Go to **Settings > AI models > Claude control (MCP)**.
   - Switch on **Let Claude control this editor** and type the pairing code.
   - A green **Claude connected** badge appears in the top bar.
4. Call `cutir_status` again after they say it is done.

The pairing code stays the same between sessions, so the user only enters it once per browser.
If the status mentions a busy port, another Cutir MCP server is running (for example a second Claude window):
ask the user to close it, or to set a different port in both the plugin (`CUTIR_MCP_PORT`) and Cutir's settings.
