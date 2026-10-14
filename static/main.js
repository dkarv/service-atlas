(async () => {
  const params = new URLSearchParams(location.search);
  const title = document.getElementById('title');

  // Base domain from ?domain or the hostname, e.g. services.example.com -> example.com
  const domain = params.get('domain') || location.hostname.split('.').slice(-2).join('.');
  title.textContent = '🗺️ of ' + domain;
  document.title = title.textContent;

  const api = new URLSearchParams({ domain });
  if (params.has('refresh')) api.set('refresh', '1');
  const res = await fetch('/api/subdomains?' + api);

  // Drop ?refresh from the address bar so a normal reload uses the cache again.
  params.delete('refresh');
  history.replaceState(null, '', '?' + params);
  const meta = document.getElementById('meta');
  const list = document.querySelector('[aria-label="Self-hosted projects"]');
  const template = document.getElementById('service-template');

  if (!res.ok) {
    title.textContent = 'Services';
    meta.textContent = 'Unable to load services.';
    template.querySelector('[data-service-name]').textContent = 'Could not load services';
    template.querySelector('[data-service-description]').textContent = 'Please try again later.';
    return;
  }

  const data = await res.json();
  // Most recently issued certificates first.
  const subs = (data.subdomains || [])
    .sort((a, b) => b.issued.localeCompare(a.issued));

  meta.textContent = 'Last refresh: ' + new Date(data.checked_at).toLocaleString();

  params.set('refresh', '1');
  const refresh = document.getElementById('refresh');
  refresh.href = '?' + params;
  refresh.hidden = false;

  if (subs.length === 0) {
    template.querySelector('[data-service-name]').textContent = 'No services found';
    template.querySelector('[data-service-description]').textContent = 'No hostnames were returned for ' + domain + '.';
    return;
  }

  for (const service of subs) {
    const article = template.cloneNode(true);
    article.removeAttribute('id');
    const name = article.querySelector('[data-service-name]');
    name.textContent = service.host;
    name.title = service.host;
    const description = article.querySelector('[data-service-description]');
    description.textContent = [service.name, service.description].filter(Boolean).join(' — ');

    const status = article.querySelector('[data-service-status]');
    if (service.error) {
      status.textContent = '🔴 unreachable';
      status.title = service.error;
    } else {
      status.textContent = (service.status < 400 ? '🟢 ' : '🟠 ') + service.status;
    }

    const icon = article.querySelector('[data-service-icon]');
    icon.onerror = () => icon.replaceWith('❓');
    icon.src = service.favicon || 'https://' + service.host + '/favicon.ico';
    icon.hidden = false;

    const link = article.querySelector('[data-service-link]');
    link.href = 'https://' + service.host;
    link.setAttribute('aria-label', 'Open ' + service.host);
    link.hidden = false;
    list.appendChild(article);
  }

  template.remove();
})();