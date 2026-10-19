// Points each download button at its file in the latest release (file names carry the version).
// Without the API (offline, rate limit), the buttons keep linking to the release page.
fetch("https://api.github.com/repos/tsuyopon123/wifisight/releases/latest")
  .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
  .then((rel) => {
    for (const a of document.querySelectorAll("a[data-asset]")) {
      const file = rel.assets.find((f) => f.name.startsWith("WiFiSight_") && f.name.endsWith(a.dataset.asset));
      if (file) a.href = file.browser_download_url;
    }
    for (const el of document.querySelectorAll("[data-version]")) {
      el.textContent = rel.tag_name;
      el.parentElement.hidden = false;
    }
  })
  .catch(() => {});
