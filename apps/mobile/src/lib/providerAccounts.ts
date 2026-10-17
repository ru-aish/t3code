import type { ServerProvider } from "@t3tools/contracts";

/** ChatGPT uses the desktop's signed-in browser, not a mobile OAuth flow. */
export function shouldShowProviderAccount(provider: ServerProvider): boolean {
  return (
    provider.driver === "chatgpt" ||
    provider.setup?.canAuthenticate === true ||
    (provider.driver === "acpRegistry" && provider.installed)
  );
}

export function chatGPTConnectionMessage(provider: ServerProvider): string {
  if (!provider.enabled) {
    return "Disabled on the server. Enable ChatGPT in desktop provider settings.";
  }
  if (!provider.installed || provider.auth.status !== "authenticated") {
    return "Not ready on the server. Open the signed-in ChatGPT desktop browser and check its Terminal MCP connection on Fedora, then refresh providers.";
  }
  return provider.models.length === 0
    ? "Connected on the server, but no models were discovered. Refresh the model catalog."
    : "Connected through ChatGPT Desktop. " +
        provider.models.length +
        " model" +
        (provider.models.length === 1 ? "" : "s") +
        " available in the model picker.";
}
