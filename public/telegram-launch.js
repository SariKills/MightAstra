// Launch parameters are only credentials to submit to the server, never proof of identity.
export function telegramLaunchData(webApp, location) {
  if (webApp?.initData) return webApp.initData;
  const fragment = new URLSearchParams((location.hash || "").replace(/^#/, ""));
  return fragment.get("tgWebAppData") || new URLSearchParams(location.search || "").get("tgWebAppData") || "";
}

export async function waitForTelegram(host, timeout = 2000) {
  const deadline = Date.now() + timeout;
  do {
    const webApp = host.Telegram?.WebApp;
    if (telegramLaunchData(webApp, host.location)) return webApp;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return host.Telegram?.WebApp;
}
