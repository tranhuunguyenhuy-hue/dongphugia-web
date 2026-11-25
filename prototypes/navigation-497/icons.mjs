const paths = {
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 18 18 0 0 1-7.9-2.8 18 18 0 0 1-5.5-5.5 18 18 0 0 1-2.8-8A2 2 0 0 1 5.6 3h3a2 2 0 0 1 2 1.7l.5 2.8a2 2 0 0 1-.5 2.1l-1.3 1.3a14 14 0 0 0 5.9 5.9l1.3-1.3a2 2 0 0 1 2.1-.5l2.7.5A2 2 0 0 1 22 16.9Z"/>',
  pin: '<path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  next: '<path d="m9 6 6 6-6 6"/>',
  back: '<path d="M20 12H5m6-6-6 6 6 6"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  bag: '<path d="M5 7h14l1.5 14h-17L5 7Zm4 2V6a3 3 0 0 1 6 0v3"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  bath: '<path d="M2 12h20m-19 0 1.4 5A4 4 0 0 0 8 20h8a4 4 0 0 0 3.6-3l1.4-5M7 20l-1 2m11-2 1 2M5 12V5a2 2 0 0 1 4 0v1"/>',
  stove: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="2"/><circle cx="16" cy="14" r="3"/><path d="M6 16h3m6-8h3"/>',
  tile: '<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M12 3v18M3 12h18"/>',
  drop: '<path d="M12 2C9 7 5 9.7 5 14a7 7 0 0 0 14 0c0-4.3-4-7-7-12Z"/><path d="M8 15c.3 1.6 1.3 2.6 3 3"/>',
  toilet: '<path d="M3 13V4h6v9m-7 0h20a6 6 0 0 1-6 6H9a6 6 0 0 1-6-6Zm7 6-1 3h9l-1-3"/>',
  lid: '<ellipse cx="12" cy="12" rx="7" ry="9"/><ellipse cx="12" cy="11" rx="4" ry="5"/>',
  sink: '<path d="M2 11h20m-19 0a9 7 0 0 0 18 0M12 11V5a2 2 0 0 1 4 0v1m-7 14h6"/>',
  faucet: '<path d="M4 21h8m-6 0V8a5 5 0 1 1 10 0v2h-3V8a2 2 0 1 0-4 0v13m5.5-7 .2 2"/>',
  shower: '<path d="M4 21V7a4 4 0 0 1 8 0v2m-3 3a4 4 0 0 1 8 0H9Zm1 4v.5m4-.5v.5m4-.5v.5m-6 3v.5m4-.5v.5"/>',
  fixture: '<path d="M3 7h18M5 7v12m14-12v12M8 7v8h8V7"/>',
  hood: '<path d="M9 3h6v6l6 6v4H3v-4l6-6V3ZM3 15h18m-11 2h4"/>',
  filter: '<path d="M4 5h16M7 5v14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V5m-7 6h4m-4 4h4"/>',
  tank: '<ellipse cx="12" cy="5" rx="7" ry="2"/><path d="M5 5v13c0 3 14 3 14 0V5M7 21h10"/>',
  heater: '<rect x="5" y="3" width="14" height="16" rx="4"/><circle cx="12" cy="14" r="1.5"/><path d="M9 19v3m6-3v3"/>',
  grid: '<rect x="4" y="4" width="6" height="6"/><rect x="14" y="4" width="6" height="6"/><rect x="4" y="14" width="6" height="6"/><rect x="14" y="14" width="6" height="6"/>',
}

export function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.grid}</svg>`
}
