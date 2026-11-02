// 套用使用者選擇的主題（auto / light / dark）到 <html data-theme>
export async function applyTheme(theme) {
  if (!theme) {
    const { settings } = await chrome.storage.local.get("settings");
    theme = settings?.theme || "auto";
  }
  if (theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  return theme;
}

export async function setTheme(theme) {
  const { settings } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...(settings || {}), theme } });
  return applyTheme(theme);
}

export function bindThemeSeg(container, current) {
  container.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", b.dataset.theme === current);
    b.onclick = async () => {
      await setTheme(b.dataset.theme);
      container.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
    };
  });
}
