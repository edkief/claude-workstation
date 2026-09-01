export const escHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const fmtCpu = value => value >= 1000 ? `${(value / 1000).toFixed(2)} cores` : `${value}m`;
export const fmtMem = value => value >= 1024 ? `${(value / 1024).toFixed(2)} GiB` : `${Math.round(value)} MiB`;
export const fmtGi = value => value == null ? '—' : `${Number(value).toFixed(1)} GiB`;
export const fmtDate = value => value ? new Date(value).toLocaleString() : '—';
export const attentionStatus = status => ['failed', 'degraded', 'dead'].includes(status);
export const barTone = percent => percent >= 85 ? 'is-critical' : percent >= 60 ? 'is-warning' : '';
