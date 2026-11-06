// 點外掛圖示 → 開啟（或切回）小伐郵件高手分頁
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("app.html");
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});
