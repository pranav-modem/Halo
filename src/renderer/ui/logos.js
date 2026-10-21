// Small app marks for the services Halo works with, drawn as inline SVG in
// each brand's colours.

const SVG = {
  gmail: `<svg viewBox="0 0 24 24"><path fill="#4285F4" d="M2 6.5v11A1.5 1.5 0 0 0 3.5 19H6V9.8L2 6.5z"/><path fill="#34A853" d="M18 19h2.5a1.5 1.5 0 0 0 1.5-1.5v-11L18 9.8V19z"/><path fill="#FBBC04" d="M18 5.6v4.2l4-3.3V5.6c0-1.5-1.7-2.3-2.9-1.4L18 5.6z"/><path fill="#EA4335" d="M6 9.8V5.6l6 4.6 6-4.6v4.2l-6 4.6z"/><path fill="#C5221F" d="M2 5.6v.9l4 3.3V5.6L4.9 4.2C3.7 3.3 2 4.1 2 5.6z"/></svg>`,
  slack: `<svg viewBox="0 0 24 24"><rect x="9.6" y="2" width="3.4" height="9" rx="1.7" fill="#36C5F0"/><rect x="2" y="11" width="9" height="3.4" rx="1.7" fill="#2EB67D" transform="rotate(0)"/><rect x="11" y="13" width="3.4" height="9" rx="1.7" fill="#ECB22E"/><rect x="13" y="9.6" width="9" height="3.4" rx="1.7" fill="#E01E5A"/><circle cx="7.3" cy="7.3" r="1.7" fill="#36C5F0"/><circle cx="16.7" cy="16.7" r="1.7" fill="#ECB22E"/><circle cx="7.3" cy="16.7" r="1.7" fill="#2EB67D"/><circle cx="16.7" cy="7.3" r="1.7" fill="#E01E5A"/></svg>`,
  github: `<svg viewBox="0 0 24 24"><mask id="gh-pr"><rect width="24" height="24" fill="#fff"/><g fill="none" stroke="#000" stroke-width="1.9" stroke-linecap="round"><circle cx="8.5" cy="7" r="1.9"/><circle cx="8.5" cy="17" r="1.9"/><circle cx="15.5" cy="17" r="1.9"/><path d="M8.5 8.9v6.2M15.5 15.1v-3.6a2.8 2.8 0 0 0-2.8-2.8h-2.2"/></g></mask><circle cx="12" cy="12" r="11" fill="currentColor" mask="url(#gh-pr)"/></svg>`,
  jira: `<svg viewBox="0 0 24 24"><defs><linearGradient id="jg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2684FF"/><stop offset="1" stop-color="#0052CC"/></linearGradient></defs><path fill="#2684FF" d="M21.4 11.2 12.8 2.6 12 1.8 2.6 11.2a1.1 1.1 0 0 0 0 1.6l5.9 5.9L12 22.2l9.4-9.4a1.1 1.1 0 0 0 0-1.6zM12 14.7 9.3 12 12 9.3l2.7 2.7L12 14.7z"/><path fill="url(#jg)" d="M12 9.3a4.6 4.6 0 0 1 0-6.5L6.1 8.7 9.3 12 12 9.3z" opacity=".85"/></svg>`,
  ninety: `<svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="6" fill="#00B386"/><text x="12" y="15.8" text-anchor="middle" font-family="-apple-system,Segoe UI,sans-serif" font-size="10" font-weight="800" fill="#fff">90</text></svg>`,
  calendar: `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3" fill="#fff" stroke="#DADCE0"/><path fill="#4285F4" d="M3 6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v2H3z"/><text x="12" y="18" text-anchor="middle" font-family="-apple-system,Segoe UI,sans-serif" font-size="8.5" font-weight="700" fill="#1A73E8">31</text></svg>`,
  halo: `<svg viewBox="0 0 24 24"><defs><linearGradient id="hg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFF4A3"/><stop offset="1" stop-color="#FFB000"/></linearGradient></defs><path fill="url(#hg)" stroke="#F08A00" stroke-width="1.2" stroke-linejoin="round" d="M12 2.8l2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6-4.5-4.2 6.1-.7z"/></svg>`,
};

/** A logo element, or null if there's no mark for that service. */
export function logo(id, size = 16) {
  if (!SVG[id]) return null;
  const el = document.createElement("span");
  el.className = `logo logo-${id}`;
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.innerHTML = SVG[id]; // fixed strings above
  return el;
}
