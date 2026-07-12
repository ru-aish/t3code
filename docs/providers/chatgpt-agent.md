# ChatGPT Agent desktop bridge

ChatGPT Agent is an external desktop target, not a T3 provider runtime. It attaches to an already-running, logged-in ChatGPT Desktop renderer through a local CDP endpoint.

In **Settings → Providers → ChatGPT Agent**, enable the target and enter the loopback endpoint (the default is `http://127.0.0.1:9337`). Select **ChatGPT Agent / ChatGPT Desktop** in the chat picker to use it.

T3 creates one normal ChatGPT conversation per T3 thread and stores the stable conversation ID in its own binding table. On the first sent turn only, T3 supplies the resolved workspace path and notes that it is the working space. T3 mirrors assistant text into its normal chat timeline; ChatGPT Desktop retains ownership of all tools, approvals, and actions.

If the app is not running, not logged in, or its renderer is incompatible, T3 reports a clear turn error and does not start a provider session or retry automatically.
