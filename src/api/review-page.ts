import { CLASS_DEFINITIONS, DOCUMENT_CLASSES } from '../domain/classes.js';
import { ChannelSchema } from '../domain/types.js';
import { QUEUES } from '../routing/route.js';

/**
 * Single-file operator console. The reviewer's job is to confirm a ready suggestion in seconds,
 * not to index from scratch, so the suggestion, evidence and reasons are on top.
 */
export function reviewPage(): string {
  const classes = DOCUMENT_CLASSES.map((c) => ({
    id: c,
    label: CLASS_DEFINITIONS[c].label,
    critical: CLASS_DEFINITIONS[c].critical,
  }));
  const boot = JSON.stringify({
    classes,
    queues: Object.values(QUEUES),
    channels: ChannelSchema.options,
  }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Doc Router</title>
<link rel="icon" href="data:,">
<style>
:root{--bg:#f6f5f2;--panel:#fff;--ink:#1c1c1a;--muted:#6b6a65;--line:#e4e2dc;--accent:#2f5d50;--p1:#b3261e;--p2:#a86b00;--p3:#5b6b73;--ok:#2f7d4f;--chip:#efede7;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--panel:#1d1d1b;--ink:#ecebe6;--muted:#9a988f;--line:#2e2d2a;--accent:#7fb8a4;--chip:#2a2926;--p1:#f08a80;--p2:#e0b04f;--p3:#9fb0b8;--ok:#7fcf9a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
header{display:flex;align-items:center;gap:16px;padding:14px 20px;border-bottom:1px solid var(--line);background:var(--panel)}
header h1{font-size:15px;margin:0;letter-spacing:.02em}header .stats{color:var(--muted);font-size:13px}
main{display:grid;grid-template-columns:minmax(300px,420px) 1fr;min-height:calc(100vh - 53px)}
@media (max-width:860px){main{grid-template-columns:1fr}}
aside{border-right:1px solid var(--line);background:var(--panel);display:flex;flex-direction:column;min-width:0}
.filters{display:flex;gap:8px;padding:12px;border-bottom:1px solid var(--line)}
select,input,textarea,button{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:6px 8px}
button{background:var(--accent);color:#fff;border:0;cursor:pointer;font-weight:600}button.secondary{background:var(--chip);color:var(--ink)}
.list{overflow:auto;flex:1}
.item{padding:10px 12px;border-bottom:1px solid var(--line);cursor:pointer;display:grid;grid-template-columns:auto 1fr auto;gap:4px 10px;align-items:center}
.item:hover,.item.active{background:var(--chip)}.item .name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.item .meta{grid-column:2/4;color:var(--muted);font-size:12px}
.prio{font:600 11px var(--mono);padding:2px 6px;border-radius:4px;color:#fff}.P1{background:var(--p1)}.P2{background:var(--p2)}.P3{background:var(--p3)}
.status{font-size:11px;color:var(--muted)}.status.NEEDS_REVIEW{color:var(--p1);font-weight:600}.status.REVIEWED{color:var(--ok)}
section.detail{padding:20px 24px;overflow:auto;min-width:0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:14px}
.card h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 10px}
.big{font-size:20px;font-weight:650}.muted{color:var(--muted)}
.chips{display:flex;flex-wrap:wrap;gap:6px}.chip{background:var(--chip);border-radius:999px;padding:2px 10px;font-size:12px}
.chip.warn{background:color-mix(in srgb,var(--p1) 18%,transparent);color:var(--p1)}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500}
.decided{color:var(--ok);font-weight:600}.abstained{color:var(--p2)}.skipped{color:var(--muted)}
pre{white-space:pre-wrap;font:12.5px/1.5 var(--mono);margin:0;max-height:420px;overflow:auto}
mark{background:color-mix(in srgb,var(--accent) 25%,transparent);color:inherit;border-radius:3px;padding:0 2px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media (max-width:1100px){.grid2{grid-template-columns:1fr}}
form.review{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.upload textarea{width:100%;min-height:140px}.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center}
ul{margin:0;padding-left:18px}.alert{color:var(--p1)}
.empty{color:var(--muted);padding:40px;text-align:center}
</style>
</head>
<body>
<header><h1>Doc Router</h1><span class="stats" id="stats"></span></header>
<main>
<aside>
  <div class="filters">
    <select id="fStatus"><option value="">Wszystkie</option><option value="NEEDS_REVIEW" selected>Do weryfikacji</option><option value="ROUTED">Skierowane</option><option value="REVIEWED">Zweryfikowane</option></select>
    <select id="fQueue"><option value="">Każda kolejka</option></select>
  </div>
  <div class="list" id="list"></div>
</aside>
<section class="detail" id="detail"></section>
</main>
<script>
const BOOT = ${boot};
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const classLabel = (id) => BOOT.classes.find((c) => c.id === id)?.label ?? id ?? 'brak';
const fmtDate = (s) => s ? new Date(s).toLocaleDateString('pl-PL') : '';
let current = null;

for (const q of BOOT.queues) $('#fQueue').insertAdjacentHTML('beforeend', '<option>' + esc(q) + '</option>');
$('#fStatus').onchange = $('#fQueue').onchange = () => loadList();

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ? JSON.stringify(body) : res.statusText);
  return body;
}

async function loadStats() {
  const { stats } = await api('/queues');
  const total = stats.reduce((s, r) => s + r.count, 0);
  const review = stats.filter((r) => r.status === 'NEEDS_REVIEW').reduce((s, r) => s + r.count, 0);
  $('#stats').textContent = total + ' pism, ' + review + ' do weryfikacji';
}

async function loadList() {
  const p = new URLSearchParams();
  if ($('#fStatus').value) p.set('status', $('#fStatus').value);
  if ($('#fQueue').value) p.set('queue', $('#fQueue').value);
  const docs = await api('/documents?' + p);
  $('#list').innerHTML = docs.length ? docs.map((d) =>
    '<div class="item' + (d.id === current ? ' active' : '') + '" data-id="' + d.id + '">' +
    '<span class="prio ' + d.priority + '">' + d.priority + '</span>' +
    '<span class="name">' + esc(d.filename) + '</span>' +
    '<span class="status ' + d.status + '">' + esc(d.status.replace('_', ' ').toLowerCase()) + '</span>' +
    '<span class="meta">' + esc(classLabel(d.label)) + ' · ' + esc(d.queue) + (d.deadline ? ' · termin ' + fmtDate(d.deadline) : '') + '</span></div>'
  ).join('') : '<div class="empty">Brak pism</div>';
  for (const el of document.querySelectorAll('.item')) el.onclick = () => showDoc(el.dataset.id);
  loadStats();
}

// Preselect the proposed queue for documents under review and the current one otherwise. Dynamic
// queues such as claim-handler:x are added so that confirming never silently changes the route.
function queueOptions(d, rt) {
  const proposed = rt.reasons.find((x) => x.startsWith('proposed:'))?.split('queue ')[1];
  const selected = d.status === 'NEEDS_REVIEW' && proposed ? proposed : d.queue;
  const all = [...new Set([selected, d.queue, ...BOOT.queues])];
  return all.map((q) => '<option' + (q === selected ? ' selected' : '') + '>' + esc(q) + '</option>').join('');
}

function highlight(text, ids) {
  let html = esc(text);
  for (const v of [...new Set(ids.map((i) => i.value))].sort((a, b) => b.length - a.length)) {
    const raw = esc(v);
    html = html.split(raw).join('<mark>' + raw + '</mark>');
  }
  return html;
}

const UNCERTAIN = {
  repaired: 'litera odczytana jako cyfra',
  unconfirmed_by_second_read: 'drugi odczyt się nie zgadza',
  handwritten_single_read: 'pismo ręczne, jeden odczyt',
};
const FACTOR = {
  checksummed_identifier: 'identyfikator z sumą kontrolną',
  second_reference: 'drugi numer',
  name_in_letter: 'nazwisko w piśmie',
};

function customerCell(en) {
  if (!en.customer) return '<span class="muted">nie znaleziono</span>';
  const c = en.customer;
  const by = c.confirmedBy.length
    ? c.confirmedBy.map((f) => '<span class="chip">' + esc(FACTOR[f] ?? f) + '</span>').join(' ')
    : '<span class="chip warn">niepotwierdzony</span>';
  return esc(c.customerId + ' ' + c.name + ' (po ' + c.matchedOn + ')') + ' ' + by;
}

// The reviewer confirms one field, not the whole letter: who is this about, with the evidence.
function candidatesBlock(en) {
  if (!en.candidates || !en.candidates.length) return '';
  return '<h3>Kandydaci</h3><ul>' + en.candidates.map((k) =>
    '<li><b>' + esc(k.customerId + ' ' + k.name) + '</b>: ' + k.evidence.map(esc).join('; ') + '</li>').join('') + '</ul>';
}

function customerOptions(en) {
  const seen = new Map();
  if (en.customer) seen.set(en.customer.customerId, en.customer.name);
  for (const k of en.candidates ?? []) if (!seen.has(k.customerId)) seen.set(k.customerId, k.name);
  if (!seen.size) return '';
  // Preselect only a confirmed match; an unconfirmed one must be chosen deliberately.
  const pre = en.customer && en.customer.confirmedBy.length && !(en.otherCustomerIds ?? []).length ? en.customer.customerId : '';
  return '<select name="customerId" aria-label="Klient"><option value="">klient: brak / nie wiem</option>' +
    [...seen].map(([id, name]) => '<option value="' + esc(id) + '"' + (id === pre ? ' selected' : '') + '>' + esc(id + ' ' + name) + '</option>').join('') +
    '</select>';
}

async function showDoc(id) {
  current = id;
  const d = await api('/documents/' + id);
  const r = d.result, c = r.classification, rt = r.routing, en = r.enrichment;
  const suggestion = d.label ?? c.suggestedLabel;
  $('#detail').innerHTML =
    '<div class="card"><h2>Decyzja</h2>' +
    '<div class="big">' + esc(classLabel(d.label ?? c.suggestedLabel)) + (d.label ? '' : ' <span class="muted">(sugestia)</span>') + '</div>' +
    '<div class="row"><span class="prio ' + d.priority + '">' + d.priority + '</span><span class="chip">kolejka: ' + esc(d.queue) + '</span>' +
    (d.deadline ? '<span class="chip warn">termin: ' + fmtDate(d.deadline) + '</span>' : '') +
    '<span class="chip">decyzja: ' + esc(d.decidedBy ?? 'człowiek') + '</span>' +
    c.reviewReasons.map((x) => '<span class="chip warn">' + esc(x) + '</span>').join('') + '</div>' +
    (c.evidence ? '<p class="muted">Dowód: „' + esc(c.evidence) + '”</p>' : '') +
    '<ul>' + rt.reasons.map((x) => '<li>' + esc(x) + '</li>').join('') + rt.alerts.map((x) => '<li class="alert">' + esc(x) + '</li>').join('') + '</ul>' +
    (d.status !== 'REVIEWED' ? '<form class="review row" id="reviewForm"><select name="correctLabel" aria-label="Klasa">' +
      BOOT.classes.map((k) => '<option value="' + k.id + '"' + (k.id === suggestion ? ' selected' : '') + '>' + esc(k.label) + '</option>').join('') +
      '</select><select name="correctQueue" aria-label="Kolejka">' + queueOptions(d, rt) +
      '</select>' + customerOptions(en) + '<input name="reviewer" placeholder="Twoje imię" required value="' + esc(localStorage.getItem('reviewer') ?? '') + '"><button>' + (d.status === 'NEEDS_REVIEW' ? 'Zatwierdź' : 'Popraw') + '</button></form>' : '<p class="muted">Zweryfikowane przez człowieka.</p>') +
    '</div>' +
    '<div class="grid2"><div class="card"><h2>Kaskada</h2><table><tr><th>Krok</th><th>Wynik</th><th>Szczegóły</th></tr>' +
    c.trace.map((s) => '<tr><td>' + esc(s.stage) + '</td><td class="' + s.outcome + '">' + esc(s.outcome) + '</td><td>' + esc(s.detail) + '</td></tr>').join('') +
    '</table>' + (c.safetyNet.length ? '<p>Siatka bezpieczeństwa: ' + c.safetyNet.map((x) => '<span class="chip warn">' + esc(x) + '</span>').join(' ') + '</p>' : '') + '</div>' +
    '<div class="card"><h2>Dane</h2><table>' +
    '<tr><th>Nadawca</th><td>' + esc(r.extraction.senderType) + '</td></tr>' +
    '<tr><th>Klient</th><td>' + customerCell(en) + '</td></tr>' +
    r.extraction.identifiers.map((i) => '<tr><th>' + esc(i.kind) + '</th><td>' + esc(i.value) + (i.valid ? '' : ' <span class="chip warn">zła suma kontrolna</span>') + (i.uncertain ? ' <span class="chip warn">' + esc(UNCERTAIN[i.uncertain] ?? i.uncertain) + '</span>' : '') + '</td></tr>').join('') +
    '<tr><th>Tekst</th><td>' + esc(r.text.source) + ', jakość ' + r.text.quality.toFixed(2) + ', ' + r.processingMs + ' ms' + (r.text.handwritten ? ' <span class="chip warn">pismo ręczne</span>' : '') + (r.text.secondRead ? ' <span class="chip">drugi odczyt: ' + r.text.secondRead.length + ' identyfikatorów</span>' : '') + '</td></tr>' +
    '</table>' + candidatesBlock(en) + '</div></div>' +
    '<div class="card"><h2>Treść</h2><pre>' + highlight(r.text.text, r.extraction.identifiers) + '</pre></div>';
  const form = $('#reviewForm');
  if (form) form.onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    localStorage.setItem('reviewer', body.reviewer);
    await api('/documents/' + id + '/review', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await loadList(); showDoc(id);
  };
  loadList();
}

function showUpload() {
  $('#detail').innerHTML = '<div class="card upload"><h2>Nowe pismo</h2>' +
    '<textarea id="upText" placeholder="Wklej treść pisma albo wybierz plik (PDF, PNG, JPG, TXT)"></textarea>' +
    '<div class="row"><input type="file" id="upFile" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.eml">' +
    '<select id="upChannel">' + BOOT.channels.filter((ch) => ch !== 'OGNIVO' && ch !== 'E_DORECZENIA').map((ch) => '<option' + (ch === 'PAPER_SCAN' ? ' selected' : '') + '>' + ch + '</option>').join('') + '</select>' +
    '<button id="upSend">Wyślij</button><span id="upMsg" class="muted"></span></div></div>' +
    '<p class="muted">Wybierz pismo z listy po lewej, żeby zobaczyć decyzję, ślad kaskady i ją poprawić.</p>';
  $('#upSend').onclick = async () => {
    $('#upMsg').textContent = 'Przetwarzam…';
    try {
      const file = $('#upFile').files[0];
      let res;
      if (file) {
        const fd = new FormData(); fd.set('file', file); fd.set('channel', $('#upChannel').value);
        res = await api('/documents', { method: 'POST', body: fd });
      } else {
        res = await api('/documents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: $('#upText').value, channel: $('#upChannel').value, filename: 'wklejone-' + new Date().toISOString().slice(11, 19) + '.txt' }) });
      }
      $('#fStatus').value = '';
      await showDoc(res.document.id);
    } catch (err) { $('#upMsg').textContent = 'Błąd: ' + err.message; }
  };
}

$('header').insertAdjacentHTML('beforeend', '<button class="secondary" style="margin-left:auto" id="newBtn">+ Nowe pismo</button>');
$('#newBtn').onclick = showUpload;
showUpload();
loadList();
</script>
</body>
</html>`;
}
