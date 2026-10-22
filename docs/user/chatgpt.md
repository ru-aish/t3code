# ChatGPT

The ChatGPT provider connects T3 Code to an authenticated ChatGPT desktop runtime and the T3-specific Terminal MCP service. It uses ChatGPT chat conversations; it is separate from the Codex provider.

In Settings → Providers, enable ChatGPT and configure the local renderer endpoint, Terminal MCP control endpoint, and control token file. Add the T3 Terminal MCP connector to your ChatGPT account before sending a message. Approve connector access in ChatGPT. Use a normal T3 project or worktree and select an available ChatGPT model. Thinking models offer the reasoning levels supported by your account.

The separate ChatGPT project control selects the cloud project for a new conversation. Choose General ChatGPT for ordinary chats, select an existing project, or create one there. That destination stays fixed for the thread; it does not change your local project or workspace folder.

To link a T3 project to a ChatGPT project, open **Settings → Projects**, select the T3 project, and use **ChatGPT project links** to pick an existing ChatGPT project. New ChatGPT conversations started in that T3 project use the linked destination automatically (including from other clients). Before the first message, the ChatGPT project control in the web or desktop composer can override it, including choosing **General ChatGPT**. Removing a link restores General ChatGPT as the default. Existing conversations keep their original destination.

T3 assigns the permanent tool identity before the first message and includes it on every send. Terminal MCP accepts only registered identities. A shared connector's allowlist rejects unknown identities; it does not authenticate which ChatGPT conversation supplied a known ID.

Terminal MCP keeps the task working until it receives completion evidence and verifies that no tools or processes remain active. It requests continuation after five minutes without tool activity, starting after the final managed process exits. Stop pauses recovery; the next user request starts a new task. Settling a thread stays local to T3.

ChatGPT can delegate tasks through T3’s orchestration tools using its Terminal MCP command access. Children inherit the selected provider and model unless overridden; available choices include other configured providers. Delegation returns immediately, and completed results automatically continue the parent thread. Child tasks appear in the existing subagent activity and can be stopped there.

This initial version supports text and image prompts, streamed responses, model switching, interrupt-and-restart steering, and PR linking through Terminal MCP. Images may be PNG, JPEG, WebP, or GIF up to 20 MiB each. Other file attachments, conversation rollback, and conversation forks are unavailable. Use another provider for titles, commit messages, and other text-generation helpers. Uncertain submissions are not automatically repeated.
