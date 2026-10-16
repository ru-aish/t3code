# ChatGPT

The ChatGPT provider connects T3 Code to an authenticated ChatGPT desktop runtime and the T3-specific Terminal MCP service. It uses ChatGPT chat conversations; it is separate from the Codex provider.

In Settings → Providers, enable ChatGPT and configure the local renderer endpoint, Terminal MCP control endpoint, and control token file. Add the T3 Terminal MCP connector to your ChatGPT account before sending a message. Use a normal T3 project or worktree and select an available ChatGPT model.

T3 assigns the permanent tool identity before the first message and includes it on every send. Terminal MCP accepts only registered identities. A shared connector's allowlist rejects unknown identities; it does not authenticate which ChatGPT conversation supplied a known ID.

Terminal MCP keeps the task working until it receives completion evidence and verifies that no tools or processes remain active. It requests continuation after five minutes without tool activity, starting after the final managed process exits. Stop pauses recovery; the next user request starts a new task. Settling a thread stays local to T3.

This initial version supports text prompts, streamed responses, model switching, interrupt-and-restart steering, and PR linking through Terminal MCP. Attachments, conversation rollback, and conversation forks are unavailable. Use another provider for titles, commit messages, and other text-generation helpers. Uncertain submissions are not automatically repeated.
