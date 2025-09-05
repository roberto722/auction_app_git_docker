// Main application script
'use strict';
// Consider using a lightweight framework (e.g., Alpine.js or lit-html) to decouple logic and markup.

// === Fullscreen helpers ===
	function isFullscreen() {
	  return document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement;
	}
	function requestFs(el) {
	  const target = el || document.documentElement; // fallback a tutta la pagina (Safari)
	  if (target.requestFullscreen) return target.requestFullscreen();
	  if (target.webkitRequestFullscreen) return target.webkitRequestFullscreen();
	  if (target.msRequestFullscreen) return target.msRequestFullscreen();
	}
	function exitFs() {
	  if (document.exitFullscreen) return document.exitFullscreen();
	  if (document.webkitExitFullscreen) return document.webkitExitFullscreen();
	  if (document.msExitFullscreen) return document.msExitFullscreen();
	}
	function onToggleFullscreen() {
	  const root = document.getElementById('monitorCard') || document.documentElement;
	  if (!isFullscreen()) { requestFs(root); } else { exitFs(); }
	}
	function onFsChange() {
	  const fs = !!isFullscreen();
	  document.documentElement.classList.toggle('is-fullscreen', fs); // usi già questa classe nel CSS
	  updateFsUi();
	}
	document.addEventListener('fullscreenchange', onFsChange);
	document.addEventListener('webkitfullscreenchange', onFsChange);
	document.addEventListener('msfullscreenchange', onFsChange);

	// scorciatoie comode
	const _monCard = document.getElementById('monitorCard');
	if (_monCard) _monCard.addEventListener('dblclick', onToggleFullscreen);
	document.addEventListener('keydown', (e) => {
	  const t = (e.target && e.target.tagName || '').toLowerCase();
	  if (t === 'input' || t === 'textarea') return;
	  if ((e.key || '').toLowerCase() === 'f') onToggleFullscreen();
	});
	window.onToggleFullscreen = onToggleFullscreen;

	function updateFsUi() {
	  const btn = document.getElementById('btnFullscreen');
	  if (!btn) return;
	  const fs = !!isFullscreen();
	  btn.style.display = fs ? 'none' : ''; // << nasconde il bottone in fullscreen
	  // opzionale: se vuoi, lascia sempre la stessa label
	  btn.textContent = 'Schermo intero';
	}

	// mantiene l’etichetta allineata
	document.addEventListener('fullscreenchange', updateFsUi);
	document.addEventListener('webkitfullscreenchange', updateFsUi);
	document.addEventListener('msfullscreenchange', updateFsUi);
	
	function showMonitorCard() {
	  const card = document.getElementById('monitorCard');
	  if (!card) return;
	  card.style.display = 'block';

	  const fsBtn = document.getElementById('btnFullscreen');
	  if (fsBtn && !fsBtn._bound) {
		fsBtn.addEventListener('click', onToggleFullscreen);
		fsBtn._bound = true; // evita doppi bind
	  }
	  updateFsUi();
	}
    // === Stato & helpers ===
    let ws = null, isHost = false;
    let currentPrice = 0, currentBidder = null, currentItem = null;
    let last3Cache = [];
    let bidHistory = [];
    let showBidderDetails = false;
    let showBidderRoster = false;
    let countdownVal = 0, tInt = null; // tInt userà requestAnimationFrame
    let playersCache = [];     // tutti i giocatori (dal CSV)
let playersView  = [];     // giocatori attualmente mostrati (filtrati/ordinati)
	// Stato tabella giocatori (filtri/sort/paginazione)
	let playersSortKey = 'Nome';  // 'Nome' | 'Ruolo' | 'Squadra' | 'ValoreBase'
	let playersSortDir = 'asc';   // 'asc' | 'desc'
	let playersPage = 1;
	let playersPageSize = 25;
    let playersTeamsSet = new Set(); // popolato dal CSV per il filtro squadre
    let myRole = null; // 'host' | 'monitor' | 'bidder'
    let myId = null;
    let myParticipantId = null;
    let myName = '';
    let usersCache = [];
    let rosterCache = {};
    let rosterViewOverride = null; // 'table' | 'cards' | null (auto)
let pendingHostLogin = false;
let pendingJoinName = '';
let auctionActive = false;  // true quando c’è un’asta in corso (per tutti i ruoli)
let calledPlayers = new Set();
	
	let isConnected = false;
    let reconnectTimer = null;
    let reconnectBackoff = 2000; // parte da 2s, raddoppia fino a 20s

	
	(function captureInviteToken(){
	  const params = new URLSearchParams(location.search);
	  const t = params.get('t') || params.get('token');
	  if (t) {
		try { localStorage.setItem('inviteToken', t); } catch {}
		const clean = location.origin + location.pathname; // rimuove query
		history.replaceState({}, '', clean);
	  }
	})();

        function doLogout(){
          // pulizia dati locali
          try { localStorage.removeItem('inviteToken'); } catch {}
          try { localStorage.removeItem('clientId'); } catch {}
          try { localStorage.removeItem('hostPin'); } catch {}

	  // chiudi eventuale WS
  try { if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, 'logout'); } catch {}
  ws = null; isHost = false; myRole = null; myId = null; myParticipantId = null; myName = '';

          // torna alla schermata iniziale
          location.href = '/';
        }

	
    function $(id){ return document.getElementById(id); }
    function setStatus(text, ok=false, err=false){ const el=$('status'); if (!el) return; el.textContent='Stato: '+text; el.className = ok?'ok':(err?'err':''); }
    function setText(id, value){ const el = $(id); if (el) el.textContent = value; }
    function hide(el){ if (el) el.style.display = 'none'; }
    function show(el){ if (el) el.style.display = 'block'; }
	
	function playerKeyFromObj(p){
	  if (!p) return '';
	  const id = p._id || p.id;
	  if (id) return 'id:'+String(id);
	  const name = (p.Nome || p.name || '').trim().toLowerCase();
	  const role = (p.Ruolo || p.role || '').trim().toLowerCase();
	  const team = (p.Squadra || p.team || '').trim().toLowerCase();
	  return `nrt:${name}|${role}|${team}`;
	}

	function keyFromNameRoleTeam(name, role, team){
	  const n = (name||'').trim().toLowerCase();
	  const r = (role||'').trim().toLowerCase();
	  const t = (team||'').trim().toLowerCase();
	  return `nrt:${n}|${r}|${t}`;
	}
	
	function nrtKeyFromParts(name, role, team){
	  const n = (name||'').trim().toLowerCase();
	  const r = (role||'').trim().toLowerCase();
	  const t = (team||'').trim().toLowerCase();
	  return `nrt:${n}|${r}|${t}`;
	}

	function addCalledForPlayerObj(p){
	  if (!p) return;
	  const id  = p._id || p.id;
	  const n   = (p.Nome || p.name || '').trim();
	  const r   = (p.Ruolo || p.role || '').trim();
	  const t   = (p.Squadra || p.team || '').trim();
	  const nrt = nrtKeyFromParts(n, r, t);

	  if (id) calledPlayers.add('id:'+String(id));
	  if (n)  calledPlayers.add('name:'+n.toLowerCase());
	  calledPlayers.add(nrt);

	  // debug
	  console.debug('[called:add]', { id, nrt, name:n });
	}

	function isPlayerCalled(p){
	  if (!p) return false;
	  const id   = p._id || p.id;
	  const name = (p.Nome || p.name || '').trim().toLowerCase();
	  const kId  = id ? ('id:'+String(id)) : null;
	  const kNrt = nrtKeyFromParts(p.Nome || p.name, p.Ruolo || p.role, p.Squadra || p.team);
	  const kNm  = name ? ('name:'+name) : null;

	  const hit = (kId && calledPlayers.has(kId)) ||
				  calledPlayers.has(kNrt) ||
				  (kNm && calledPlayers.has(kNm));

	  // debug
	  // console.debug('[called:check]', { kId, kNrt, kNm, hit });

	  return hit;
	}
	
	let invitesCache = [];
	let invitesBusy = false;

	function inviteJoinUrl(token) {
	  return `${location.origin}/?t=${encodeURIComponent(token)}`;
	}

	async function fetchInvites() {
	  const r = await fetch('/host/invite/list');
	  const j = await r.json();
	  if (!j.success || !Array.isArray(j.invites)) {
		throw new Error('Impossibile caricare gli inviti');
	  }
	  invitesCache = j.invites.map(inv => ({
		id: inv.id,
		name: inv.name || inv.participantId || '—',
		token: inv.token,
		revoked: !!inv.revoked,
		participantId: inv.participantId || null,   // 👈 AGGIUNTO
	  }));
	  renderInvitesTable();
	}
	
	function renderInvitesTable() {
	  const tb = document.getElementById('invitesBody');
	  if (!tb) return;
	  tb.innerHTML = '';

	  (invitesCache || []).forEach(inv => {
		const url = inv.token ? inviteJoinUrl(inv.token) : '';
		const inviteId = inv.id || inv._id; // compat
		const linked  = !!inv.participantId;

		const nameCellHtml = `
		  ${escapeHtml(inv.name || inv.participantId || '—')}
		  ${linked ? '<span class="badge-linked" title="Questo invito è legato a un participant salvato">linked</span>' : ''}
		`;

		const actionsHtml = inv.revoked
		  ? '<span class="badge-called">revocato</span>'
		  : `
			<button class="btn" data-invite-action="copy" data-id="${inviteId}">Copia</button>
			<button class="btn" data-invite-action="rotate" data-id="${inviteId}">Ruota</button>
			<button class="btn btn-danger" data-invite-action="revoke" data-id="${inviteId}">Revoca</button>
		  `;

		const tr = document.createElement('tr');
		tr.innerHTML = `
		  <td>${nameCellHtml}</td>
		  <td style="text-align:left">
			<input type="text" readonly value="${url}" style="width:100%" />
		  </td>
		  <td>${actionsHtml}</td>
		`;
		tb.appendChild(tr);
	  });
	}

        function setConnectionBanner(connected){
          const bar = document.getElementById('connectionBanner');
          if (!bar) return;
          bar.style.display = connected ? 'none' : 'flex';
          bar.style.background = connected ? 'rgba(17,17,17,0.9)' : '#7c2d12';
          let span = bar.querySelector('span');
          if (!span) { span = document.createElement('span'); bar.prepend(span); }
          span.textContent = connected ? 'Sei connesso.' : 'Disconnesso. Ritento a breve…';
          let btn = bar.querySelector('#reconnectBtn');
          if (!connected) {
                if (!btn) {
                  btn = document.createElement('button');
                  btn.id = 'reconnectBtn';
                  btn.className = 'btn';
                  btn.textContent = 'Riconnetti ora';
                  btn.onclick = ()=> { cancelReconnect(); ensureWS(autoRejoin); };
                  bar.appendChild(btn);
                }
          } else {
                if (btn) btn.remove();
          }
        }

        function autoRejoin(){
	  // 1) preferisci il token invito se presente
	  const token = localStorage.getItem('inviteToken');
	  if (token) {
		ws.send(JSON.stringify({ type:'join-by-invite', token }));
		// se l’utente aveva selezionato host in precedenza, prova il PIN salvato
		const last = JSON.parse(localStorage.getItem('lastLogin') || '{}');
		if (last?.role === 'host' && last?.pin) {
		  ws.send(JSON.stringify({ type:'host-login', pin: last.pin }));
		}
		return;
	  }
	  // 2) fallback: usa l’ultimo login manuale salvato
  try {
const last = JSON.parse(localStorage.getItem('lastLogin') || '{}');
if (last?.name && last?.role) {
  if (last.role === 'host' || last.role === 'monitor') {
        if (last.pin) {
          ws.send(JSON.stringify({ type:'join', name:last.name, role:'monitor', pin:last.pin }));
          if (last.role === 'host') ws.send(JSON.stringify({ type:'host-login', pin:last.pin }));
        }
  }
}
  } catch {}
	}
	
	function scheduleReconnect(){
	  if (reconnectTimer) return;
	  reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		ensureWS(autoRejoin);
		// backoff progressivo fino a 20s
		reconnectBackoff = Math.min(reconnectBackoff * 2, 20000);
	  }, reconnectBackoff);
	}

        function cancelReconnect(){
          if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
          reconnectBackoff = 2000;
          setConnectionBanner(true);
        }

        function markDisconnectedUI(){
          isConnected = false;
          setStatus('Disconnesso. Riconnessione…', false, true);
          setConnectionBanner(false);
          setBidButtonsEnabled(false);
        }



	function renderInviteUsersSelect() {
	  // Popola il <select> con gli utenti NON host
	  const sel = document.getElementById('inviteUserSelect');
	  if (!sel) return;

	  const list = (usersCache || []).filter(u => !u.isHost);
	  sel.innerHTML = list.map(u => {
		const label = escapeHtml(u.name || u.id);
		const badge = u.participantId ? '' : ' (ospite)';
		// value = participantId (se esiste), data-client-id = id di sessione
		return `<option value="${u.participantId || ''}" data-client-id="${u.id}">${label}${badge}</option>`;
	  }).join('');
	}


	document.addEventListener('visibilitychange', () => {
	  if (document.visibilityState === 'visible') {
		// se non è proprio aperto, tenta subito
		if (!ws || ws.readyState !== WebSocket.OPEN) {
		  cancelReconnect();
		  ensureWS(autoRejoin);
		}
	  }
	});
	window.addEventListener('focus', () => {
	  if (!ws || ws.readyState !== WebSocket.OPEN) {
		cancelReconnect();
		ensureWS(autoRejoin);
	  }
	});

	
	// Crea invito da nome/ruolo (utente non ancora connesso)
	document.addEventListener('click', async (e) => {
	  if (!e.target || e.target.id !== 'inviteCreateByNameBtn') return;
	  if (invitesBusy) return;
	  invitesBusy = true; e.target.disabled = true;

	  const name = (document.getElementById('invNameNew')?.value || '').trim();
	  const role = (document.getElementById('invRoleNew')?.value || 'bidder');
	  if (!name) { showToast('Inserisci un nome', 'warn'); invitesBusy = false; e.target.disabled = false; return; }

	  try {
		const r = await fetch('/host/invite/create', {
		  method: 'POST',
		  headers: {'Content-Type':'application/json'},
		  body: JSON.stringify({ name, role })
		});
		const j = await r.json();
		if (!j.success) throw new Error(j.error || 'Errore creazione invito');

		// copia subito il link costruito dal token dell'invito
		const link = inviteJoinUrl(j.invite.token);
		try { await navigator.clipboard.writeText(link); showToast('Link copiato', 'ok'); } catch {}

		// pulizia campo + refresh lista
		const inp = document.getElementById('invNameNew'); if (inp) inp.value = '';
		await fetchInvites();
		showToast('Invito creato', 'ok');
	  } catch (err) {
		showToast(err.message || 'Errore invito', 'error');
	  } finally {
		invitesBusy = false; e.target.disabled = false;
	  }
	});




	// Un solo listener per tutte le azioni (delegation)
	document.addEventListener('click', async (e) => {
	  const btn = e.target.closest('[data-invite-action]');
	  if (!btn) return;

	  const action = btn.getAttribute('data-invite-action');
	  const id = btn.getAttribute('data-id');

	  try {
		if (action === 'copy') {
		  const tr = btn.closest('tr');
		  const input = tr.querySelector('input[readonly]');
		  input.select(); input.setSelectionRange(0, 99999);
		  await navigator.clipboard.writeText(input.value);
		  showToast('Link copiato', 'ok');
		  return;
		}

		if (invitesBusy) return;
		invitesBusy = true; btn.disabled = true;

		if (action === 'revoke') {
		  await fetch('/host/invite/revoke', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id })});
		  await fetchInvites();
		  showToast('Invito revocato', 'ok');
		} else if (action === 'rotate') {
		  await fetch('/host/invite/rotate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id })});
		  await fetchInvites();
		  showToast('Nuovo link generato', 'ok');
		}
	  } catch (err) {
		showToast(err.message || 'Errore invito', 'error');
	  } finally {
		invitesBusy = false; btn.disabled = false;
	  }
	});

	// Crea invito per l’utente selezionato (solo su click)
	document.addEventListener('click', async (e) => {
	  if (!e.target || e.target.id !== 'inviteCreateBtn') return;
  const sel = document.getElementById('inviteUserSelect');
  if (!sel || sel.selectedIndex < 0) { showToast('Seleziona un partecipante', 'warn'); return; }
	  if (invitesBusy) return;
	  invitesBusy = true; e.target.disabled = true;

	  try {
		const opt = sel.selectedOptions[0];
		const participantId = opt.value || null;                // può essere '' se assente
		const clientId = opt.getAttribute('data-client-id')||''; // id di sessione
		// Trova il nome visualizzato nella tabella utenti
		const user = usersCache.find(u => u.id === clientId);

		const body = participantId
		  ? { participantId, name: user?.name || '' }  // bind a participant esistente
		  : { clientId,       name: user?.name || '' }; // crea participant dal client connesso

		const r = await fetch('/host/invite/create', {
		  method: 'POST',
		  headers: {'Content-Type':'application/json'},
		  body: JSON.stringify(body)
		});
		const j = await r.json();
		if (!j.success) throw new Error(j.error || 'Errore creazione invito');

		await fetchInvites();          // refresh tabella inviti
		showToast('Invito pronto', 'ok');
	  } catch (err) {
		showToast(err.message || 'Errore invito', 'error');
	  } finally {
		invitesBusy = false; e.target.disabled = false;
	  }
	});

	// Aggiorna elenco on-demand (no polling)
	document.addEventListener('click', (e) => {
	  if (e.target && e.target.id === 'inviteRefreshBtn') fetchInvites().catch(err => showToast(err.message, 'error'));
	});

	// Popola select quando arrivano gli users
	// (nel tuo ws.onmessage, dopo broadcast user-list, chiama)
	function onUsersUpdatedForInvites() {
	  renderInviteUsersSelect();
	}


	// Marca chiamato a partire da un payload websocket
	function markCalledFromPayload(d){
	  // Host/monitor ricevono d.item {name, role, team}, bidder solo playerName.
	  if (d && d.item && d.item.name) {
		calledPlayers.add(keyFromNameRoleTeam(d.item.name, d.item.role, d.item.team));
	  } else if (d && d.playerName) {
		// fallback meno preciso se abbiamo solo il nome
		const k = `name:${String(d.playerName).trim().toLowerCase()}`;
		calledPlayers.add(k);
	  }
	}
	
	function showAssignBanner(text, isNone=false){
	  const box = document.getElementById('monAssign');
	  const txt = document.getElementById('monAssignText');
	  if (!box || !txt) return;
	  txt.textContent = text;
	  box.style.display = 'block';
	  box.classList.toggle('assign-banner--none', !!isNone);
	}

	function hideAssignBanner(){
	  const box = document.getElementById('monAssign');
	  if (!box) return; // safe guard
	  box.style.display = 'none';
	  box.classList.remove('assign-banner--none');
	}
	
	// stato
let roundMode = false;
let roundOrder = [];
let currentNominatorId = null;
window._roundNames = window._roundNames || {};

function onHostStartRound(){
  const strat = document.getElementById('roundStrategy')?.value || 'random';
  ensureWS(()=> ws.send(JSON.stringify({ type:'host:start-round', strategy: strat })));
}
function onHostStopRound(){
  ensureWS(()=> ws.send(JSON.stringify({ type:'host:stop-round' })));
}

function onToggleBidderDetails(){
  const cb = document.getElementById('toggleBidderDetails');
  const enabled = !!cb?.checked;
  ensureWS(()=> ws.send(JSON.stringify({ type:'host:set-bidder-details', enabled })));
}

function onToggleBidderRoster(){
  const cb = document.getElementById('toggleBidderRoster');
  const enabled = !!cb?.checked;
  ensureWS(()=> ws.send(JSON.stringify({ type:'host:set-roster-visibility', enabled })));
}

function isMyTurn(){ return roundMode && myParticipantId && currentNominatorId === myParticipantId; }

function renderRoundInfo(){
  const box = document.getElementById('roundInfo'); // se hai un box host opzionale
  if (box) {
    if (!roundMode) { box.textContent = 'Round Robin: disattivato'; }
    else {
      const names = (roundOrder||[]).map(id => (window._roundNames[id] || 'Anonimo'));
      const curName = window._roundNames[currentNominatorId] || '—';
      box.textContent = `Round attivo • Ordine: ${names.join(' → ')} • Tocca a: ${curName}`;
    }
  }
}

function onBidderNominate(){
  if (!isMyTurn()) { showToast('Non è il tuo turno per nominare.', 'warn'); return; }
  if (auctionActive) { showToast('C’è già un’asta in corso.', 'warn'); return; }
  const q = (document.getElementById('nominateSearch')?.value || '').trim().toLowerCase();
  if (!q) { showToast('Inserisci il nome del giocatore.', 'warn'); return; }
  const exact = playersCache.find(p => (p.Nome||'').toLowerCase() === q);
  const cand  = exact || playersCache.find(p => (p.Nome||'').toLowerCase().includes(q));
  if (!cand) { showToast('Giocatore non trovato nel CSV.', 'error'); return; }
  ensureWS(()=> ws.send(JSON.stringify({ type:'bidder:nominate', player: cand })));
}

function renderBidderNominateBox(){
  const box = document.getElementById('bidderNominateBox');
  const turnEl = document.getElementById('roundWhoseTurn');
  const btn = document.getElementById('openNomBtn');
  if (!box || !turnEl || !btn) return;

  const curName = window._roundNames[currentNominatorId] || '—';
  turnEl.textContent = curName;

  const visible = (myRole === 'bidder' && roundMode);
  box.style.display = visible ? 'block' : 'none';

  const enable = isMyTurn() && !auctionActive;
  btn.disabled = !enable;
  btn.style.opacity = enable ? '1' : '0.6';
  btn.style.cursor  = enable ? 'pointer' : 'not-allowed';
}

// ===== Dataset nomina (view + paginazione/filtri) =====
let nomView = [];
let nomPage = 1;
let nomPageSize = 25;
let nomTeamsSet = new Set();

function nomHydrateTeams(){
  nomTeamsSet = new Set();
  for (const p of (playersCache||[])) if (p.Squadra) nomTeamsSet.add(String(p.Squadra));
  const sel = document.getElementById('nomTeamFilter');
  if (!sel) return;
  const cur = sel.value || '';
  const teams = Array.from(nomTeamsSet).sort((a,b)=> a.localeCompare(b,'it',{sensitivity:'base'}));
  sel.innerHTML = `<option value="">Tutte le squadre</option>` + teams.map(t =>
    `<option value="${escapeHtml(t)}"${t===cur?' selected':''}>${escapeHtml(t)}</option>`
  ).join('');
}

// --- (Opzionale) Popola il <select> ruoli nella modale bidder ---
// Richiede un <select id="nomRoleFilter">
function nomHydrateRoles() {
  const sel = document.getElementById('nomRoleFilter');
  if (!sel) return;

  const cur = sel.value || '';
  const collator = new Intl.Collator('it', { sensitivity: 'base' });

  const roles = [...new Set(
    (playersCache || []).map(p => (p.Ruolo || '').trim()).filter(Boolean)
  )].sort((a,b)=> collator.compare(a,b));

  sel.innerHTML = `<option value="">Tutti i ruoli</option>` +
    roles.map(r => `<option value="${escapeHtml(r)}"${r===cur?' selected':''}>${escapeHtml(r)}</option>`).join('');
}

// --- (Opzionale) Applica i filtri della modale e rerenderizza la lista nomine ---
// Richiede gli elementi: #nomSearch, #nomRoleFilter, #nomTeamFilter, #nomList (tbody/div)
function nomApplyFilters() {
  const q     = (document.getElementById('nomSearch')?.value || '').trim().toLowerCase();
  const role  = (document.getElementById('nomRoleFilter')?.value || '').trim().toLowerCase();
  const team  = (document.getElementById('nomTeamFilter')?.value || '').trim();

  const collator = new Intl.Collator('it', { sensitivity: 'base' });

  const list = (playersCache || []).filter(p => {
    const nm = (p.Nome || '').toLowerCase();
    const rl = (p.Ruolo || '').toLowerCase();
    const sq = (p.Squadra || '');

    if (q && !(nm.includes(q) || rl.includes(q) || sq.toLowerCase().includes(q))) return false;
    if (role && rl !== role) return false;
    if (team && sq !== team) return false;
    return true;
  }).sort((a,b) => collator.compare(a.Nome||'', b.Nome||''));

  const container = document.getElementById('nomList');
  if (!container) return;

  // Esempio: tbody con righe “nome / ruolo / squadra / azione”
  container.innerHTML = list.map((p, i) => `
    <tr>
      <td>${i+1}</td>
      <td>${escapeHtml(p.Nome || '')}</td>
      <td>${escapeHtml(p.Ruolo || '')}</td>
      <td>${escapeHtml(p.Squadra || '')}</td>
      <td><button class="btn" data-nominate="${escapeHtml(p._id || p.Nome || '')}">Nomina</button></td>
    </tr>
  `).join('');

  // Bind dei bottoni “Nomina” nella modale
  container.querySelectorAll('button[data-nominate]').forEach(btn => {
  btn.addEventListener('click', (e) => {
    const key = e.currentTarget.getAttribute('data-nominate');
    const player = (playersCache || []).find(p => (p._id || p.Nome) === key);
    if (!player) return;
    ensureWS(() => ws.send(JSON.stringify({ type: 'bidder:nominate', player })));
    closeNominateModal?.();
  });
});

}

function onNomSearchInput(){
  clearTimeout(onNomSearchInput._t);
  onNomSearchInput._t = setTimeout(() => {
    nomPage = 1;
    buildNomView();
    renderNomPage();
  }, 120);
}
function onNomFiltersChange(){
  nomPage = 1;
  buildNomView();
  renderNomPage();
}
function onNomPageSizeChange(){
  const sel = document.getElementById('nomPageSize');
  nomPageSize = Math.max(1, parseInt(sel.value,10) || 25);
  nomPage = 1;
  renderNomPage();
}

function buildNomView(){
  const q    = (document.getElementById('nomSearch')?.value || '').trim().toLowerCase();
  const team = (document.getElementById('nomTeamFilter')?.value || '').trim();
  const role = (document.getElementById('nomRoleFilter')?.value || '').trim();

  nomView = (playersCache || []).filter(p => {
    const nm = (p.Nome || '').toLowerCase();
    const rl = (p.Ruolo || '').toLowerCase();
    const sq = (p.Squadra || '').toLowerCase();
    if (q && !(nm.includes(q) || rl.includes(q) || sq.includes(q))) return false;
    if (team && String(p.Squadra) !== team) return false;
    if (role && rl !== role.toLowerCase()) return false;
    return true;
  }).sort((a,b)=>{
    // default: alfabetico per nome
    return (a.Nome||'').localeCompare(b.Nome||'', 'it', {sensitivity:'base'});
  });
}

function updateNomPager(total){
  const curEl = document.getElementById('nomPageCur');
  const maxEl = document.getElementById('nomPageMax');
  const cntEl = document.getElementById('nomCount');
  const max = Math.max(1, Math.ceil(total / nomPageSize));
  if (curEl) curEl.textContent = String(nomPage);
  if (maxEl) maxEl.textContent = String(max);
  if (cntEl) cntEl.textContent = String(total);
}

function nomGoPage(what){
  const max = Math.max(1, Math.ceil(nomView.length / nomPageSize));
  if (what==='first') nomPage = 1;
  else if (what==='prev') nomPage = Math.max(1, nomPage-1);
  else if (what==='next') nomPage = Math.min(max, nomPage+1);
  else if (what==='last') nomPage = max;
  renderNomPage();
}

function renderNomPage(){
  const tb = document.getElementById('nomBody');
  if (!tb) return;
  tb.innerHTML = '';

  const total = nomView.length;
  const start = Math.max(0, (nomPage-1) * nomPageSize);
  const end   = Math.min(total, start + nomPageSize);
  const rows  = nomView.slice(start, end);

  rows.forEach((p, i) => {
    const absIndex = start + i;
    const nome = p.Nome || '';
    const ruolo = p.Ruolo || '';
    const squadra = p.Squadra || '';
    const base = p.ValoreBase || 0;

    let thumb = '';
    const img = (p.Immagine || '').toString().trim();
    if (img) {
      const src = img.startsWith('/') ? img
      : /^https?:\/\//i.test(img) ? `/img-proxy?u=${encodeURIComponent(img)}`
      : '';
      if (src) thumb = `<img src="${src}" alt="" style="height:28px;width:auto;border-radius:6px;border:1px solid #eee" onerror="this.style.display='none'">`;
    }

    const canNominate = isMyTurn() && !auctionActive;

    // 👇 usa la stessa chiave e set della lista host
    const isCalled = isPlayerCalled(p);

    const tr = document.createElement('tr');
    if (isCalled) tr.classList.add('tr-called');

    tr.innerHTML = `
      <td>${absIndex+1}</td>
      <td style="display:flex;align-items:center;gap:8px;">
${thumb}
<span>${escapeHtml(nome)}</span>
${isCalled ? '<span class="badge-called">chiamato</span>' : ''}
      </td>
      <td>${escapeHtml(ruolo)}</td>
      <td>${escapeHtml(squadra)}</td>
      <td>${base}</td>
      <td>
<button class="btn btn-primary" data-nom-idx="${absIndex}" ${canNominate ? '' : 'disabled'}>
  ${canNominate ? 'Nomina' : '—'}
</button>
      </td>
    `;
    tb.appendChild(tr);
  });

  tb.querySelectorAll('button[data-nom-idx]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const i = parseInt(e.currentTarget.getAttribute('data-nom-idx'),10);
      const p = nomView[i];
      if (!p) return;
      doNominatePlayer(p);
    });
  });

  updateNomPager(total);
}


function openNominateModal(){
  if (!roundMode) { showToast('Round non attivo.', 'warn'); return; }
  if (!isMyTurn()) { showToast('Non è il tuo turno.', 'warn'); return; }
  if (auctionActive) { showToast('C’è già un’asta in corso.', 'warn'); return; }

  nomHydrateTeams();
  buildNomView();
  nomPage = 1;
  renderNomPage();

  const m = document.getElementById('nominateModal');
  if (m) m.style.display = 'block';
}

function closeNominateModal(){
  const m = document.getElementById('nominateModal');
  if (m) m.style.display = 'none';
}

function doNominatePlayer(p){
  if (!roundMode) { showToast('Round non attivo.', 'warn'); return; }
  if (!isMyTurn()) { showToast('Non è il tuo turno.', 'warn'); return; }
  if (auctionActive) { showToast('C’è già un’asta in corso.', 'warn'); return; }
  ensureWS(()=> ws.send(JSON.stringify({ type:'bidder:nominate', player: p })));
  closeNominateModal();
}
		
	// --- Toast helpers ---
	let toastWrap;
	function ensureToastWrap() {
	  if (!toastWrap) {
		toastWrap = document.createElement('div');
		toastWrap.className = 'toast-wrap';
		document.body.appendChild(toastWrap);
	  }
	}
	function showToast(msg, kind='error', ms=3000) {
	  ensureToastWrap();
	  const el = document.createElement('div');
	  el.className = 'toast ' + (kind ? `toast--${kind}` : '');
	  el.textContent = String(msg || '');
	  toastWrap.appendChild(el);
	  setTimeout(()=> {
		el.style.opacity = '0';
		el.style.transition = 'opacity .25s ease';
		setTimeout(()=> el.remove(), 250);
	  }, ms);
	}

    // ✅ LOGIN UI: bind select/btn alla load
    document.addEventListener('DOMContentLoaded', () => {
  // auto-join se ho già un invito salvato
  const token = localStorage.getItem('inviteToken');
  if (token) {
ensureWS(() => {
  try { ws.send(JSON.stringify({ type: 'join-by-invite', token })); } catch {}
});
  }

  // costruzione UI + bind login
  buildUI();

  const roleSel = $('joinRole');
  const pinRow  = $('pinRow');
  const btn     = $('loginBtn');

  // Se non c'è un token d'invito, rimuovi l'opzione partecipante
  if (!token && roleSel) {
const opt = roleSel.querySelector('option[value="bidder"]');
if (opt) opt.remove();
  }

  if (roleSel) {
// mostra il campo PIN per monitor e host
const roleChange = e => {
  const role = e.target.value;
  pinRow.style.display = (role === 'host' || role === 'monitor') ? '' : 'none';
};
roleSel.addEventListener('change', roleChange);
// stato iniziale
roleChange({ target: roleSel });
  }
  if (btn) btn.addEventListener('click', doLogin);
});
		
		document.addEventListener('click', (e) => {
		  const btn = e.target.closest('[data-expel]');
		  if (!btn) return;

		  if (!isHost) { showToast('Solo il gestore può espellere utenti.', 'warn'); return; }

		  const clientId = btn.getAttribute('data-expel');
		  const user = (usersCache || []).find(u => u.id === clientId);
		  const nome = user?.name || clientId;

		  if (!confirm(`Espellere ${nome}?`)) return;

		  // opzionale: feedback immediato UI
		  btn.disabled = true;

		  ensureWS(() => {
			try {
			  ws.send(JSON.stringify({ type: 'host:expel', clientId }));
			  showToast(`Espulso: ${nome}`, 'ok');
			} catch {
			  btn.disabled = false;
			  showToast('Errore di invio espulsione', 'error');
			}
		  });
		});

		
		document.addEventListener('click', (e) => {
		  const el = e.target?.closest('#btnSkipNominator, #btnKickAnon');
		  if (!el) return;
		  e.preventDefault();

		  if (el.id === 'btnSkipNominator') {
			// opzionale: blocca se non sei host
			if (!isHost) { showToast('Solo il gestore può skippare.', 'warn'); return; }
			console.log('[UI] sending host:skip-nominator');
			ensureWS(() => ws.send(JSON.stringify({ type: 'host:skip-nominator' })));
		  }

		  if (el.id === 'btnKickAnon') {
			if (!isHost) { showToast('Solo il gestore può eliminare anonimi.', 'warn'); return; }
			console.log('[UI] sending host:kick-anon');
			ensureWS(() => ws.send(JSON.stringify({ type: 'host:kick-anon' })));
		  }
		});


	function renderLog(entries){
    const tb = document.getElementById('logBody');
    if (!tb) return;
    let html = '';
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      const time = new Date(e.time).toLocaleTimeString();
      let label = e.type;
      if (label==='bid') label='Offerta';
      if (label==='auction-start') label='Inizio';
      if (label==='auction-end') label='Fine';
      if (label==='timer-set') label='Timer';
      if (label==='kick') label='Espulsione';
      if (label==='budgets-set') label='Budget iniziali';
      if (label==='bidder-update') label='Agg. bidder';
      html += `<tr>
<td>${time}</td>
<td>${label}</td>
<td>${e.item ? (e.item.name || '') : ''}</td>
<td>${e.name || e.target || ''}</td>
<td>${e.amount || ''}</td>
<td>${e.winner || ''}</td>
      </tr>`;
    }
    tb.innerHTML = html;
    // ultimi eventi in alto
    const wrap = document.querySelector('.table-wrap--log');
    if (wrap) wrap.scrollTop = 0;
  }
	
    function doLogin(){
  const token = localStorage.getItem('inviteToken');
  const name  = (document.getElementById('joinName')?.value || '').trim();
  const role  = document.getElementById('joinRole')?.value || 'bidder';
  const pin   = (document.getElementById('hostPin')?.value || '').trim();

  // ⬇️ memorizza un "ultimo login" soltanto se NON stai usando un invito
  if (!token) {
try {
  localStorage.setItem('lastLogin', JSON.stringify({ name, role, pin: (role==='host'?pin:'') }));
} catch {}
  }

  if (!token && role === 'bidder') {
alert('I partecipanti devono usare un link d\'invito.');
return;
  }

  ensureWS(() => {
if (token) {
  ws.send(JSON.stringify({ type:'join-by-invite', token }));
  if (role === 'host' && pin) ws.send(JSON.stringify({ type:'host-login', pin }));
  return;
}
if (!name) { alert('Inserisci il nome'); return; }
 if (role === 'monitor' || role === 'host') {
  if (!pin) { alert('Inserisci il PIN gestore'); return; }
  ws.send(JSON.stringify({ type:'join', name, role: 'monitor', pin }));
  if (role === 'host') {
        ws.send(JSON.stringify({ type:'host-login', pin }));
  }
  return;
}
  });
}



	function cryptoRandomId(){
	  const a = new Uint8Array(16);
	  (window.crypto || window.msCrypto).getRandomValues(a);
	  return Array.from(a, b=>b.toString(16).padStart(2,'0')).join('');
	}

	let pingTimer = null;
	function startClientPing(){
	  if (pingTimer) clearInterval(pingTimer);
	  pingTimer = setInterval(() => {
		try {
		  if (ws && ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ type:'ping', t: Date.now() }));
		  }
		} catch {}
	  }, 20000); // 20s
	}
	
	function stopClientPing(){
	  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
	}

    function ensureWS(thenSend){
      if (ws && ws.readyState === WebSocket.OPEN) { thenSend && thenSend(); return; }

	  const url = (location.protocol==='https:'?'wss://':'ws://') + location.host;
	  setStatus('Connessione al server…');
	  try { if (ws) ws.close(1000); } catch {}
	  ws = new WebSocket(url);

      ws.addEventListener('open', ()=>{
		isConnected = true;
		cancelReconnect();
                setStatus('Connesso.');
                // ping keep-alive parte/ri-parte
                startClientPing();
		// auto-rejoin (token invito o ultimo login)
		(thenSend || autoRejoin)();
	  }, { once:true });

      ws.onmessage = (e)=>{
let d; try{ d = JSON.parse(e.data); } catch { return; }

// 🔹 JOIN riuscito (bidder/monitor)
if (d.type === 'joined') {
  myRole = d.role || 'bidder';
  if (d.clientId) myId = d.clientId;
  if (d.participantId) myParticipantId = d.participantId;
  myName = d.name || '';

		  // Se stiamo facendo login host, NON cambiare UI qui.
		  if (pendingHostLogin) {
			// opzionale: puoi aggiornare uno stato di attesa
			return;
		  }

		  // Altrimenti, flusso normale bidder/monitor
		  setStatus(`Benvenuto ${d.name}! (${myRole})`, true);
		  document.getElementById('loginCard')?.style?.setProperty('display', 'none');
		  if (myRole === 'bidder') {
			document.getElementById('bidderCard').style.display = 'block';
                        const row = document.getElementById('bidderMetaRow'); if (row) row.style.display = 'none';
                        const rowCountdown = document.getElementById('bidderCountdownRow'); if (rowCountdown) rowCountdown.style.display = 'none';
                  }
  if (myRole === 'monitor') {
          showMonitorCard();
  }
  document.getElementById('meName') && (document.getElementById('meName').textContent = d.name || '');
  const userSpan = document.getElementById('bottomUserName');
  if (userSpan) userSpan.textContent = d.name || '';
  const rosterHost = document.getElementById('rosterCard');
  const rosterBidder = document.getElementById('rosterCardBidder');
  if (rosterHost) rosterHost.style.display = myRole === 'host' ? 'block' : 'none';
  const canShowRoster = myRole === 'host' || (myRole === 'bidder' && showBidderRoster);
  if (rosterBidder) rosterBidder.style.display = canShowRoster ? 'block' : 'none';
  const histBtn = document.querySelector('button[data-target="infoHistory"]');
  const histSection = document.getElementById('infoHistory');
  if (myRole === 'host' || myRole === 'monitor') {
        if (histBtn) histBtn.style.display = 'none';
        if (histSection) histSection.style.display = 'none';
  } else {
        if (histBtn) histBtn.style.display = '';
        if (histSection) histSection.style.display = '';
  }
  renderProfile();
  return;
}

if (d.type === 'show-bidder-details') {
  showBidderDetails = !!d.enabled;
  const cb = document.getElementById('toggleBidderDetails');
  if (cb) cb.checked = showBidderDetails;
  applyAuctionPayload({ type: 'state', item: showBidderDetails ? currentItem : null, playerName: currentItem ? currentItem.name : null, price: currentPrice, bidder: currentBidder, last3: last3Cache });
  return;
}

if (d.type === 'show-roster-bidders') {
  showBidderRoster = !!d.enabled;
  const cb = document.getElementById('toggleBidderRoster');
  if (cb) cb.checked = showBidderRoster;
  const rosterHost = document.getElementById('rosterCard');
  const rosterBidder = document.getElementById('rosterCardBidder');
  if (rosterHost) rosterHost.style.display = myRole === 'host' ? 'block' : 'none';
  const canShowRoster = myRole === 'host' || (myRole === 'bidder' && showBidderRoster);
  if (rosterBidder) rosterBidder.style.display = canShowRoster ? 'block' : 'none';
  return;
}

// update round state dentro handler “state / auction-started / new-bid”
if (d.type === 'state' || d.type === 'auction-started' || d.type === 'new-bid') {
  if ('roundMode' in d) roundMode = !!d.roundMode;
  if ('nominationOrder' in d && Array.isArray(d.nominationOrder)) roundOrder = d.nominationOrder;
  if ('currentNominatorId' in d) currentNominatorId = d.currentNominatorId;
  if ('showBidderDetails' in d) {
    showBidderDetails = !!d.showBidderDetails;
    const cb = document.getElementById('toggleBidderDetails');
    if (cb) cb.checked = showBidderDetails;
  }
  if (Array.isArray(d.last3)) last3Cache = d.last3;
  if (d.item) currentItem = d.item;
  else if (d.playerName != null) currentItem = { ...(currentItem||{}), name: d.playerName };

  if (d.type === 'auction-started' || d.type === 'state') {
    bidHistory = Array.isArray(d.last3) ? d.last3.slice() : [];
    renderHistory();
  } else if (d.type === 'new-bid') {
    bidHistory.push({ name: d.name || d.bidder || '', amount: Number(d.amount || d.price || 0) });
    if (bidHistory.length > 20) bidHistory = bidHistory.slice(-20);
    renderHistory();
  }

  if (myRole === 'monitor') {
    setMonPrice(d.amount || d.price || 0);
    renderLast3Chips(d.last3 || []);
    // opzionale: un leggero “tick” di countdown se vuoi
    // paintFancyCountdown(d.secondsRimasti ?? ...);
  }

  if (d.type === 'new-bid' && Number.isFinite(d.seconds)) {
    startCountdown(d.seconds);
    if (myRole === 'monitor') paintFancyCountdown(d.seconds);
  }

  applyAuctionPayload(d);
  renderRoundInfo();
  renderBidderNominateBox();
  return;
}

		// handler specifico broadcast round
		if (d.type === 'round-state') {
		  roundMode = !!d.roundMode;
		  roundOrder = Array.isArray(d.order) ? d.order : [];
		  currentNominatorId = d.current || null;
		  window._roundNames = d.names || {};
		  renderRoundInfo();
		  renderBidderNominateBox();
		  return;
		}
		
		if (d.type === 'host:skip-ack') {
		  console.log('[WS] host:skip-ack', d);
		  const msg =
			d.ok ? `Turno passato: ${d.prevName ?? '—'} → ${d.nextName ?? '—'}`
				 : `Skip non eseguito (${d.reason})`;
		  showToast(msg, d.ok ? 'ok' : 'warn');
		  // opzionale: aggiorna subito roundInfo se il server non ha già broadcastato
		  renderRoundInfo();
		  return;
		}

// HOST autenticato
if (d.type === 'host-auth') {
                  if (d.success) {
                        myRole = 'host'; isHost = true;
                        if (d.clientId) myId = d.clientId;

			// fine attesa host
			pendingHostLogin = false;

			setStatus('Login gestore ✅', true);

			// mostra host, nascondi tutto il resto
        document.getElementById('loginCard')?.style?.setProperty('display', 'none');
        document.getElementById('bidderCard')?.style?.setProperty('display', 'none');
        document.getElementById('monitorCard')?.style?.setProperty('display', 'none');
        document.getElementById('hostCard')?.style?.setProperty('display', 'block');
        document.getElementById('rosterCard')?.style?.setProperty('display', 'block');
         // chiedi subito la lista utenti
        try {
          ws.send(JSON.stringify({ type:'host:get-users' }));
          ws.send(JSON.stringify({ type:'host:get-rosters' }));
        } catch {}
        renderUsers(usersCache);
  } else {
        // PIN errato → torna alla login “normale”
			pendingHostLogin = false;
			setStatus('PIN errato ❌', false, true);
		  }
		  return;
		}


if (d.type === 'players-list') {
		  playersCache = d.players || [];
		  renderPlayers();              // già lo fai per la vista host
		  nomHydrateTeams();            // 👈 popola il filtro squadre nella modale bidder
		  nomHydrateRoles();            // (opzionale) popola il filtro ruoli
		  nomApplyFilters();            // (opzionale) aggiorna la lista nella modale se già aperta
		  return;
		}


if (d.type === 'user-list') {
  const base = d.users || [];
  if (isHost) {
    fetch('/host/participants/list').then(r=>r.json()).then(j=>{
      usersCache = j.participants || base;
      renderUsers(usersCache);
      renderInviteUsersSelect();
      renderRosters(rosterCache);
      renderProfile();
    }).catch(()=>{
      usersCache = base;
      renderUsers(usersCache);
      renderInviteUsersSelect();
      renderRosters(rosterCache);
      renderProfile();
    });
  } else {
    usersCache = base;
    renderUsers(usersCache);
    renderInviteUsersSelect();
    renderRosters(rosterCache);
    renderProfile();
  }
  return;
}

if (d.type === 'roster-update') {
  rosterCache = d.roster || {};
  renderRosters(rosterCache);
  return;
}

if (d.type === 'timer-updated') { setText('timerCur', d.seconds); }

		if (d.type === 'reset-timer') {
		  startCountdown(d.seconds);
		  if (myRole === 'monitor') {
			startFancyCountdown(d.seconds || 0);
			paintFancyCountdown(d.seconds || 0);
		  }
		  return;
		}

if (d.type === 'auction-ended') {
		  const name = d.item?.name ?? d.playerName ?? '—';
		  if (myRole !== 'monitor') {
			const name = d.item?.name ?? d.playerName ?? '—';
		    alert(`Asta terminata: ${name} → ${d.winner} (${d.amount})`);
		  }
 // ➜ SOLO MONITOR: banner di assegnazione
		  if (myRole === 'monitor') {
			const winner = (d.winner || '').trim();
			const amount = Number(d.amount || 0);

			if (winner && winner.toLowerCase() !== 'nessuno') {
			  showAssignBanner(`Assegnato a ${winner} per ${amount} FM`);
			} else {
			  showAssignBanner(`${name}: non assegnato...`, true);
			}
		  }

		  stopCountdown();
		  renderLast3(d.last3 || []);
		  renderLast3Chips(d.last3 || []);
		  currentItem = null; 
		  currentPrice = 0; 
		  currentBidder = null;

		  // UI comuni già presenti...
		  applyAuctionPayload({ item: null, playerName: null, price: 0, name: null });

		  // stato e pulsanti
		  auctionActive = false;
		  setBidButtonsEnabled(false);
   // Nascondi righe meta/countdown nel pannello bidder e pulisci campi
  const metaRow = document.getElementById('bidderMetaRow');
  const cntRow  = document.getElementById('bidderCountdownRow');
  const roleRow = document.getElementById('bidderRoleRow');
  const teamRow = document.getElementById('bidderTeamRow');
  const last3Row = document.getElementById('bidderLast3Row');
  if (metaRow) metaRow.style.display = 'none';
  if (cntRow)  cntRow.style.display  = 'none';
  setText('countdownBid', '—');
  setText('countdownBidMobile', '—');
  if (roleRow) roleRow.style.display = 'none';
  if (teamRow) teamRow.style.display = 'none';
  if (last3Row) last3Row.style.display = 'none';
  setText('itemPriceBid', 0);
  setText('itemBidderBid', '—');
  setText('itemPriceBidMobile', 0);
  setText('itemBidderBidMobile', '—');
  setText('itemRoleBid', '—');
  setText('itemTeamBid', '—');
  setText('itemLast3Bid', '—');

		  // reset colori/immagine monitor/host
		  const monRoleEl  = $('monRole');
		  const hostRoleEl = $('itemRoleHost');
		  if (monRoleEl)  monRoleEl.classList.remove('role-por','role-dif','role-cent','role-att');
		  if (hostRoleEl) hostRoleEl.classList.remove('role-por','role-dif','role-cent','role-att');
		  const imgEl = $('monImg'); if (imgEl) imgEl.src = '/placeholder.jpg';

		  renderBidderNominateBox();

		  return;
		}

if (d.type === 'log-update' && isHost) { renderLog(d.entries||[]); return; }
if (d.type === 'error') {
		  // Mostra un toast visibile a chiunque (bidder/monitor/host)
		  showToast(d.message || 'Errore', 'error', 3500);
		  // opzionale: continua anche ad aggiornare eventuale #status se lo usi altrove
		  setStatus(d.message || 'Errore', false, true);
		  return;
		}
if (d.type === 'expelled') { alert('Sei stato espulso'); location.reload(); return; }
      };

      ws.addEventListener('error', ()=> setStatus('Errore WebSocket', false, true));
	  
	  ws.onclose = () => {
		stopClientPing(); 
		markDisconnectedUI();
		scheduleReconnect();
	  };
    }

    function computeMaxBid(credits, slotsByRole){
      const c = Math.max(0, Number(credits||0));
      const S = slotsByRole || {};
      const tot = Math.max(0, (S.por||0)+(S.dif||0)+(S.cen||0)+(S.att||0));
      return Math.max(0, c - Math.max(0, tot - 1));
    }
	
function getMyUser(){
  if (myParticipantId) {
    return (usersCache||[]).find(u => u.participantId === myParticipantId) || null;
  }
  if (myId) {
    return (usersCache||[]).find(u => u.id === myId) || null;
  }
  return null;
}

	function getMyMaxBid(){
	  const me = getMyUser();
	  if (!me) return 0;
	  return computeMaxBid(me.credits, me.slotsByRole);
	}


    function updateBidderBudget(me){
          const credits = Number(me.credits || 0);
          const initCr  = Number(me.initialCredits ?? credits);
          const S       = me.slotsByRole || {};
          const spent   = Math.max(0, initCr - credits);
          const maxBid  = computeMaxBid(credits, S);

          setText('meCredits', credits);
          setText('meSpent', spent);
          setText('meMaxBid', maxBid);

          // Se hai gli indicatori slot nel pannello bidder:
          setText('meSlotsPor', Number(S.por ?? 0));
          setText('meSlotsDif', Number(S.dif ?? 0));
          setText('meSlotsCen', Number(S.cen ?? 0));
          setText('meSlotsAtt', Number(S.att ?? 0));
        }

        function renderProfile(){
          const box = document.getElementById('infoProfileContent');
          if (!box) return;
          const me = getMyUser();
          const name = (me && me.name) || myName;
          box.innerHTML = '';
          if (!name) {
                box.innerHTML = '<div class="info-box">Dati profilo non disponibili</div>';
          } else if (myRole === 'bidder' && me) {
                updateBidderBudget(me);
                const S = me.slotsByRole || {};
                const spent = Math.max(0, Number(me.initialCredits ?? 0) - Number(me.credits || 0));
                const maxBid = computeMaxBid(me.credits, S);
                const prof = document.createElement('div');
                prof.className = 'info-box';
                prof.innerHTML = `
                  <div><b>${escapeHtml(name)}</b></div>
                  <div>Crediti: ${me.credits ?? 0}</div>
                  <div>Spesi: ${spent}</div>
                  <div>Max puntata: ${maxBid}</div>
                `;
                const slots = document.createElement('div');
                slots.className = 'info-box';
                slots.innerHTML = `
                  <div><b>Slot rimanenti</b></div>
                  <div>POR: ${S.por||0}</div>
                  <div>DIF: ${S.dif||0}</div>
                  <div>CEN: ${S.cen||0}</div>
                  <div>ATT: ${S.att||0}</div>
                `;
                box.appendChild(prof);
                box.appendChild(slots);
          } else {
                const prof = document.createElement('div');
                prof.className = 'info-box';
                prof.innerHTML = `<div><b>${escapeHtml(name)}</b></div>`;
                box.appendChild(prof);
          }

          if (myRole) {
                const logoutBtn = document.createElement('button');
                logoutBtn.textContent = 'Logout';
                logoutBtn.className = 'btn btn-danger profile-logout-btn';
                logoutBtn.addEventListener('click', doLogout);
                box.appendChild(logoutBtn);
          }
        }

        function renderHistory(){
          const box = document.getElementById('infoHistoryContent');
          if (!box) return;
          box.innerHTML = '';
          if (!bidHistory.length) {
                box.innerHTML = '<div class="info-box">Nessuna puntata</div>';
                return;
          }
          const wrap = document.createElement('div');
          wrap.className = 'info-box';
          const ul = document.createElement('ul');
          bidHistory.slice().reverse().forEach(b => {
                const li = document.createElement('li');
                li.textContent = `${b.name} — ${b.amount}`;
                ul.appendChild(li);
          });
          wrap.appendChild(ul);
          box.appendChild(wrap);
        }


    // Mappa ruolo → classe colore
    function roleToClass(roleText = "") {
      const r = roleText.toLowerCase();
      if (r.includes("portiere") || r.startsWith("por")) return "role-por";
      if (r.includes("difensore") || r.startsWith("dif")) return "role-dif";
      if (r.includes("centrocamp"))                     return "role-cent";
      if (r.includes("attaccante") || r.startsWith("att")) return "role-att";
      return null;
    }
	
	// 1) evidenzia il cambio prezzo (lazy lookup)
	let _lastPrice = null;
	function setMonPrice(v) {
	  const el = document.getElementById('monPrice'); // lookup quando serve
	  if (!el) { _lastPrice = v; return; }
	  if (_lastPrice !== null && _lastPrice !== v) {
		el.classList.add('tick');
		setTimeout(() => el.classList.remove('tick'), 220);
	  }
	  el.textContent = v;
	  _lastPrice = v;
	}

	// 2) countdown circolare
	const ring = document.getElementById('monRing');
	const ringTxt = document.getElementById('monTime');
	let _countdownTotal = 0;
	function startFancyCountdown(totalSeconds){
	  _countdownTotal = Math.max(1, Number(totalSeconds) || 1);
	  paintFancyCountdown(_countdownTotal); // reset pieno
	}
	function paintFancyCountdown(remainingSeconds){
	  if (!ring) return;
	  const rem = Math.max(0, Number(remainingSeconds) || 0);
	  const p = Math.max(0, Math.min(1, rem / _countdownTotal || 0));
	  ring.style.setProperty('--p', p);
	  const col = rem <= 3 ? 'var(--danger)' :
				  rem <= 5 ? 'var(--warn)'   : 'var(--ok)';
	  ring.style.setProperty('--col', col);
	  if (ringTxt) ringTxt.textContent = rem < 5 ? (rem <= 0 ? '0' : rem.toFixed(1)) : String(Math.ceil(rem));
	}

	// 3) “Ultimi 3” come chip
	function renderLast3Chips(list){
	  const box = document.getElementById('last3Chips');
	  if (!box) return;
	  box.innerHTML = '';
	  (list||[]).slice().reverse().forEach(e=>{
		const el = document.createElement('span');
		el.className = 'chip';
		el.textContent = `${e.name} • ${e.amount}`;
		box.appendChild(el);
	  });
	}


    // Applica payload d'asta (invariato dalla tua versione aggiornata)
    function applyAuctionPayload(d) {
	  const isHM = (myRole === 'host' || myRole === 'monitor');

  // Aggiorna prezzo e top bidder sempre (anche su new-bid)
  currentPrice  = Number(d.price ?? d.amount ?? currentPrice ?? 0);
  const base = Number(currentPrice) || 0;
  // Update both desktop and mobile bid inputs if they exist and aren't active
  const activeEl = document.activeElement;
  // Update both desktop and mobile bid inputs if they exist
  const bidAmountEl = $('bidAmount');
  if (bidAmountEl && activeEl !== bidAmountEl) {
    bidAmountEl.value = String(base + 1);
  }
  const bidAmountMobileEl = $('bidAmountMobile');
  if (bidAmountMobileEl && activeEl !== bidAmountMobileEl) {
    bidAmountMobileEl.value = String(base + 1);
  }
  currentBidder = d.bidder ?? d.name ?? currentBidder ?? null;

	  // Aggiorna auctionActive SOLO quando il payload è informativo
	  // - auction-started / state -> possiamo dedurre se c'è un item
	  // - new-bid -> NON toccare auctionActive
	  // - auction-ended -> handled anche fuori, ma per sicurezza spegniamo qui
	  if (d.type === 'auction-started' || d.type === 'state') {
		  const hasItemForHM  = !!(d.item && d.item.name != null);   // host/monitor
		  const hasNameForBid = (d.playerName != null);              // bidder
		  const isActive = hasItemForHM || hasNameForBid;

		  auctionActive = isActive;

		  if (myRole === 'monitor') {
			const price = Number(d.price || 0);
			const secs  = Number(d.seconds ?? 0);

			setMonPrice(price); 

			if (isActive) {
			  if (Number.isFinite(secs) && secs > 0) {
				startFancyCountdown(secs);
				paintFancyCountdown(secs); // inizializza ring
			  } else {
				// stato senza seconds (es. solo 'state'): porta il ring a zero
				startFancyCountdown(0);
				paintFancyCountdown(0);
			  }
			  hideAssignBanner?.();        // togli il banner “assegnato”
			  renderLast3Chips([]);        // pulisci “ultimi 3”
			}
		  }

		} else if (d.type === 'auction-ended') {
		  auctionActive = false;
		}
if ((d.type === 'auction-started' || (d.type === 'state' && (d.item || d.playerName))) && myRole === 'monitor') {
		  hideAssignBanner();
		}
		
                if (myRole === 'bidder') {
                  renderProfile();
                }
		
		if ((d.type === 'auction-started' || d.type === 'state') && d.item && d.item.name) {
		  addCalledForPlayerObj({
			_id: d.item._id,
			Nome: d.item.name,
			Ruolo: d.item.role,
			Squadra: d.item.team
		  });
		}

	
		// Segna come chiamato il giocatore che sta iniziando l'asta
		if (d.type === 'auction-started') {
			addCalledForPlayerObj({
				_id: d.item?._id,
				Nome: d.item?.name ?? d.playerName,
				Ruolo: d.item?.role ?? '',
				Squadra: d.item?.team ?? ''
			  });
		  markCalledFromPayload(d);
		  // rerender liste se visibili
			renderPlayersPage();
			if (typeof renderNomPage === 'function') renderNomPage();
		}

	  // Nome da mostrare (non spegnere l’asta se manca su new-bid)
	  const name =
		(isHM && d.item && d.item.name != null) ? d.item.name :
		(d.playerName != null) ? d.playerName :
		(d.item && d.item.name != null ? d.item.name : null);

	  // === HOST / MONITOR ===
	  if (isHM) {
if (d.item) {
  // Immagine: locale (/players/xxx.jpg) oppure URL esterno (passato tramite proxy)
  const imgEl = document.getElementById('monImg');
  if (imgEl) {
        const raw = (d.item?.image ?? '').toString().trim();
        let src = '/placeholder.jpg';
        if (raw) {
          if (raw.startsWith('/')) {
                src = raw; // path locale già servito da Express (es. /players/audero.jpg)
          } else if (/^https?:\/\//i.test(raw)) {
                src = `/img-proxy?u=${encodeURIComponent(raw)}`; // usa il proxy per evitare CORS/cache
                // In alternativa: src = raw;
          }
        }
        imgEl.src = src;
        imgEl.onerror = () => { imgEl.onerror = null; imgEl.src = '/placeholder.jpg'; };
  }
   // Testi host + monitor
  setText('itemNameHost', d.item.name || '—');
  setText('itemRoleHost', d.item.role || '—');
  setText('itemTeamHost', d.item.team || '—');
   setText('monName', d.item.name || '—');
  setText('monRole', d.item.role || '—');
  setText('monTeam', d.item.team || '—');
   // Colori ruolo
  const cls = roleToClass(d.item.role || "");
  const monRoleEl  = $('monRole');
  const hostRoleEl = $('itemRoleHost');
  if (monRoleEl)  { monRoleEl.classList.remove('role-por','role-dif','role-cent','role-att'); if (cls) monRoleEl.classList.add(cls); }
  if (hostRoleEl) { hostRoleEl.classList.remove('role-por','role-dif','role-cent','role-att'); if (cls) hostRoleEl.classList.add(cls); }
} else if (name != null) {
  // Solo nome (es. su 'state' minimale)
  setText('itemNameHost', name);
  setText('monName', name);
  const monRoleEl  = $('monRole');  if (monRoleEl)  monRoleEl.classList.remove('role-por','role-dif','role-cent','role-att');
  const hostRoleEl = $('itemRoleHost'); if (hostRoleEl) hostRoleEl.classList.remove('role-por','role-dif','role-cent','role-att');
		}

		// Prezzo/offerente
		setText('itemPriceHost', currentPrice);
		setMonPrice(currentPrice);
		setText('itemBidderHost', currentBidder || '—');

                // Nome visibile anche sul pannello bidder
if (name != null) { setText('itemNameBidMobile', name); }

		if (Array.isArray(d.last3)) {
		  renderLast3(d.last3);
		  renderLast3Chips(d.last3);
		}
  if (typeof d.seconds === 'number' && d.type !== 'new-bid') startCountdown(d.seconds);

		// Abilita/disabilita i bottoni di puntata in base allo stato corrente
		setBidButtonsEnabled(auctionActive);
		return;
	  }

          // === BIDDER ===
  if (name != null) {
    setText('itemNameBidMobile', name);
    const imgEl = document.getElementById('itemImgBidMobile');
    if (imgEl) {
      const raw = (d.item?.image ?? '').toString().trim();
      let src = '/placeholder.jpg';
      if (raw) {
        if (raw.startsWith('/')) {
          src = raw;
        } else if (/^https?:\/\//i.test(raw)) {
          src = `/img-proxy?u=${encodeURIComponent(raw)}`;
        }
      }
      imgEl.src = src;
      imgEl.onerror = () => { imgEl.onerror = null; imgEl.src = '/placeholder.jpg'; };
    }
  }
    if (typeof d.seconds === 'number' && d.type !== 'new-bid') startCountdown(d.seconds);
  const metaRow = document.getElementById('bidderMetaRow');
  const cntRow  = document.getElementById('bidderCountdownRow');
  const roleRow = document.getElementById('bidderRoleRow');
  const teamRow = document.getElementById('bidderTeamRow');
  const last3Row = document.getElementById('bidderLast3Row');

  if (showBidderDetails) {
    if (metaRow) { metaRow.style.display = 'block'; setText('itemPriceBid', currentPrice); setText('itemBidderBid', currentBidder || '—'); }
    setText('itemPriceBidMobile', currentPrice); setText('itemBidderBidMobile', currentBidder || '—');
    if (cntRow)  cntRow.style.display = 'block';
    if (roleRow) { roleRow.style.display = 'block'; setText('itemRoleBid', d.item?.role || currentItem?.role || '—'); }
    if (teamRow) { teamRow.style.display = 'block'; setText('itemTeamBid', d.item?.team || currentItem?.team || '—'); }
    if (last3Row) {
      last3Row.style.display = 'block';
      const l3 = d.last3 || last3Cache || [];
      const txt = l3.map(e => `${e.name} (${e.amount})`).join(', ');
      setText('itemLast3Bid', txt || '—');
    }
  } else {
    if (metaRow) { metaRow.style.display = 'none'; setText('itemPriceBid', 0); setText('itemBidderBid', '—'); }
    setText('itemPriceBidMobile', 0); setText('itemBidderBidMobile', '—');
    if (cntRow)  { cntRow.style.display = 'none'; setText('countdownBid', '—'); }
    setText('countdownBidMobile', '—');
    if (roleRow) { roleRow.style.display = 'none'; setText('itemRoleBid', '—'); }
    if (teamRow) { teamRow.style.display = 'none'; setText('itemTeamBid', '—'); }
    if (last3Row) { last3Row.style.display = 'none'; setText('itemLast3Bid', '—'); }
  }

  // Non spegnere su new-bid: usa lo stato calcolato sopra
  setBidButtonsEnabled(auctionActive);
}



    function renderLast3(list){
      const ul = $('last3'); if (!ul) return;
      ul.innerHTML = '';
      (list || []).slice().reverse().forEach(entry => {
const li = document.createElement('li');
li.textContent = `${entry.name} — ${entry.amount}`;
ul.appendChild(li);
      });
    }

    // Countdown con decimi <5s, colori e zero finale garantito
    function startCountdown(seconds){
      const endAt = performance.now() + Math.max(0, seconds) * 1000
      stopCountdown();
	  
	  startFancyCountdown(seconds);

      const elMon  = $('monTime');
      const elHost = $('countdownHost');
      const elBid  = $('countdownBid');
      const elBidMob = $('countdownBidMobile');

      function paint(msLeft){
if (msLeft < 0) msLeft = 0;
const secs = msLeft / 1000;

const warn   = (secs <= 5 && secs > 3);
const danger = (secs <= 3);
[elMon, elHost].forEach(el=>{
  if (!el) return;
  el.classList.remove('time-warn','time-danger');
  if (danger) el.classList.add('time-danger');
  else if (warn) el.classList.add('time-warn');
});

let display;
if (secs < 5) {
  const tenthsDown = Math.floor(secs * 10 + 1e-6) / 10;
  display = (tenthsDown <= 0) ? "0" : tenthsDown.toFixed(1);
} else {
  display = String(Math.ceil(secs));
}

if (elMon)  elMon.textContent  = display;      // pedice "s" è nel DOM
if (elHost) elHost.textContent = display + 's';
if (elBid)  elBid.textContent  = display + 's';
if (elBidMob) elBidMob.textContent = display + 's';
		
		paintFancyCountdown(secs);
	  }

      function tick(now){
const msLeft = endAt - now;
if (msLeft <= 0) {
  paint(0);
  stopCountdown();
  return;
}
paint(msLeft);
tInt = requestAnimationFrame(tick);
      }

      paint(endAt - performance.now());
      tInt = requestAnimationFrame(tick);
    }

    function stopCountdown(){
      if (tInt) {
try { cancelAnimationFrame(tInt); } catch {}
try { clearInterval(tInt); } catch {}
tInt = null;
      }
      const elMon  = $('monTime');
      const elHost = $('countdownHost');
      [elMon, elHost].forEach(el=>{
if (!el) return;
el.classList.remove('time-warn','time-danger');
      });
    }

    function onAdjCredits(clientId, delta){
      ensureWS(()=> ws.send(JSON.stringify({ type:'host:update-bidder', clientId, creditsDelta: delta })));
    }
    function onAdjSlotRole(clientId, role, delta){
      ensureWS(()=> ws.send(JSON.stringify({ type:'host:update-bidder', clientId, slotsDeltaRole: { role, delta } })));
    }

function renderUsers(list){
  const tb = $('users'); if (!tb) return;
  tb.innerHTML = '';

  (list||[]).forEach(u=>{
const S = u.slotsByRole || { por:0, dif:0, cen:0, att:0 };
const credits = Number(u.credits ?? 0);
const initCr  = Number(u.initialCredits ?? credits);
const spent   = Math.max(0, initCr - credits);
 const tr = document.createElement('tr');
tr.innerHTML = `
  <td>${escapeHtml(u.name || '—')}<br><small>${escapeHtml(u.participantId || '')}</small></td>
  <td>${escapeHtml(u.isHost ? 'Gestore' : (u.role || 'bidder'))}</td>
  <td>${u.online ? '🟢 online' : '⚪ offline'}</td>
  <td class="mono">${credits}</td>
  <td class="mono">${spent}</td>
  <td class="mono">${Number(S.por ?? 0)}</td>
  <td class="mono">${Number(S.dif ?? 0)}</td>
  <td class="mono">${Number(S.cen ?? 0)}</td>
  <td class="mono">${Number(S.att ?? 0)}</td>
  <td></td>
`;
 const tdActions = tr.lastElementChild;
 const isMe = (u.participantId === myParticipantId);
 // helper per creare bottoni coerenti
const addBtn = (label, cb, { title='', className='btn', disabled=false, ariaLabel='' } = {}) => {
  const b = document.createElement('button');
  b.textContent = label;
  b.className = className;
  if (title) b.title = title;
  if (ariaLabel) b.setAttribute('aria-label', ariaLabel);
  b.disabled = !!disabled;
  b.onclick = cb;
  return b;
};
 // Azioni solo se NON host e online
if (!u.isHost && u.online) {
  // Crediti ±
  tdActions.append(
        addBtn('−10', ()=> onAdjCredits(u.id, -10), { title:'-10 crediti', ariaLabel:`Riduci 10 crediti a ${u.name||'utente'}` }),
			addBtn('−1',  ()=> onAdjCredits(u.id, -1),  { title:'-1 credito',  ariaLabel:`Riduci 1 credito a ${u.name||'utente'}` }),
			addBtn('+1',  ()=> onAdjCredits(u.id, +1),  { title:'+1 credito',  ariaLabel:`Aumenta 1 credito a ${u.name||'utente'}` }),
			addBtn('+10', ()=> onAdjCredits(u.id, +10), { title:'+10 crediti', ariaLabel:`Aumenta 10 crediti a ${u.name||'utente'}` }),
			document.createTextNode(' | ')
		  );

		  // Slot per ruolo ±
		  [['POR','por'], ['DIF','dif'], ['CEN','cen'], ['ATT','att']].forEach(([lbl, key]) => {
			tdActions.append(
			  addBtn(`${lbl}−`, ()=> onAdjSlotRole(u.id, key, -1), { title:`Slot ${lbl} -1`, ariaLabel:`Rimuovi uno slot ${lbl} a ${u.name||'utente'}` }),
			  addBtn(`${lbl}+`, ()=> onAdjSlotRole(u.id, key, +1), { title:`Slot ${lbl} +1`, ariaLabel:`Aggiungi uno slot ${lbl} a ${u.name||'utente'}` })
			);
		  });

		  tdActions.append(document.createTextNode(' | '));

		  // Espelli singolo giocatore (solo se l'host è collegato e non stiamo espellendo noi stessi)
		  const canKick = isHost && !isMe;
		  tdActions.append(
			addBtn('Espelli', () => {
			  // doppia guardia
			  if (!canKick) return;
			  const nm = u.name || 'partecipante';
			  const ok = confirm(`Espellere "${nm}" dalla sessione?`);
			  if (!ok) return;

			  ensureWS(() => {
				try {
				  ws.send(JSON.stringify({ type: 'host:expel', clientId: u.id }));
				  // server:
				  //  - chiude la ws del target
				  //  - pushLog({type:'kick', ...})
				  //  - broadcastUsers()
				  //  - il 'close' del client espulso ripulisce nominationOrder/currentNominator e fa broadcastRoundState()
				  // lato UI riceverai: user-list/round-state aggiornati
				} catch (e) {
				  console.error('Expel send error', e);
				}
			  });
			}, {
			  title: 'Espelli partecipante',
			  className: 'btn btn-danger',
			  disabled: !canKick,
			  ariaLabel: `Espelli ${u.name || 'partecipante'}`
			})
		  );
		}

  tb.appendChild(tr);
  });
}

function getRosterViewMode(){
  return rosterViewOverride || (window.innerWidth < 600 ? 'cards' : 'table');
}

function renderRosters(map){
  rosterCache = map || rosterCache || {};
  const wraps = ['rosterList', 'rosterListBidder'].map(id => $(id)).filter(Boolean);
  if (!wraps.length) return;
  wraps.forEach(w => w.innerHTML = '');

  const bidderIds = Array.from(new Set([
    ...Object.keys(rosterCache),
    ...(usersCache||[]).map(u => u.participantId).filter(Boolean)
  ]));
  const bidders = bidderIds.map(pid => {
    const u = (usersCache||[]).find(x => x.participantId === pid);
    return { id: pid, name: u ? (u.name || pid) : pid };
  });

  const roleOrder = ['P','D','C','A'];
  const byBidder = {};

  bidders.forEach(b => {
    const players = (rosterCache[b.id] || []).slice().sort((a, b) =>
      roleOrder.indexOf(a.fascia) - roleOrder.indexOf(b.fascia)
    );
    const grouped = {};
    roleOrder.forEach(r => { grouped[r] = players.filter(p => p.fascia === r); });
    byBidder[b.id] = grouped;
  });
  const mode = getRosterViewMode();
  wraps.forEach(wrap => {
    if (mode === 'cards') {
      const roleLabels = { P:'Portieri', D:'Difensori', C:'Centrocampisti', A:'Attaccanti' };
      bidders.forEach(b => {
        const det = document.createElement('details');
        det.className = 'roster-card';
        const sum = document.createElement('summary');
        sum.textContent = b.name;
        det.appendChild(sum);
        roleOrder.forEach(r => {
          const arr = byBidder[b.id][r];
          if (!arr.length) return;
          const roleWrap = document.createElement('div');
          const title = document.createElement('div');
          title.className = 'roster-role-title';
          title.textContent = roleLabels[r] || r;
          roleWrap.appendChild(title);
          const ul = document.createElement('ul');
          ul.className = 'roster-role-list';
          arr.forEach(player => {
            const li = document.createElement('li');
            if (player.fascia) li.classList.add('fascia-' + player.fascia);
            const imgSrc = player.img ? `/img-proxy?u=${encodeURIComponent(player.img)}` : '/placeholder.jpg';
            li.innerHTML = `<img src="${imgSrc}" alt="" style="width:32px;height:32px;object-fit:contain;"> <span>${escapeHtml(player.name||'')}</span> <span class="mono">${player.price ?? 0}</span>`;
            if (myRole === 'host') {
              const btnRem = document.createElement('button');
              btnRem.textContent = 'Remove';
              btnRem.className = 'btn btn-danger btn-sm';
              btnRem.onclick = () => ensureWS(()=>ws.send(JSON.stringify({ type:'host:remove-player', participantId: b.id, playerId: player.id })));
              const btnRe = document.createElement('button');
              btnRe.textContent = 'Reassign';
              btnRe.className = 'btn btn-ghost btn-sm';
              btnRe.onclick = () => {
                const others = (usersCache||[]).filter(u => u.participantId && u.participantId !== b.id);
                const choices = others.map(u => `${u.participantId} - ${u.name}`).join('\n');
                const toId = prompt('Assegna a quale partecipante?\n'+choices, others[0]?.participantId || '');
                if (toId) ensureWS(()=>ws.send(JSON.stringify({ type:'host:reassign-player', fromId: b.id, toId, playerId: player.id })));
              };
              li.appendChild(btnRem);
              li.appendChild(btnRe);
            }
            ul.appendChild(li);
          });
          roleWrap.appendChild(ul);
          det.appendChild(roleWrap);
        });
        wrap.appendChild(det);
      });
    } else {
      const table = document.createElement('table');
      table.className = 'roster-table';
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      bidders.forEach(b => {
        const th = document.createElement('th');
        th.textContent = b.name;
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');

      roleOrder.forEach(r => {
        let max = 0;
        bidders.forEach(b => { max = Math.max(max, byBidder[b.id][r].length); });
        for (let i = 0; i < max; i++) {
          const tr = document.createElement('tr');
          bidders.forEach(b => {
            const player = byBidder[b.id][r][i];
            const td = document.createElement('td');
            if (player) {
              td.classList.add('player-td');
              if (player.fascia) td.classList.add('fascia-' + player.fascia);
              const imgSrc = player.img ? `/img-proxy?u=${encodeURIComponent(player.img)}` : '/placeholder.jpg';
              td.innerHTML = `<img src="${imgSrc}" alt="" style="width:32px;height:32px;object-fit:contain;"> <span>${escapeHtml(player.name||'')}</span> <span class="mono">${player.price ?? 0}</span>`;
              if (myRole === 'host') {
                const btnRem = document.createElement('button');
                btnRem.textContent = 'Remove';
                btnRem.className = 'btn btn-danger btn-sm';
                btnRem.onclick = () => ensureWS(()=>ws.send(JSON.stringify({ type:'host:remove-player', participantId: b.id, playerId: player.id })));
                const btnRe = document.createElement('button');
                btnRe.textContent = 'Reassign';
                btnRe.className = 'btn btn-ghost btn-sm';
                btnRe.onclick = () => {
                  const others = (usersCache||[]).filter(u => u.participantId && u.participantId !== b.id);
                  const choices = others.map(u => `${u.participantId} - ${u.name}`).join('\n');
                  const toId = prompt('Assegna a quale partecipante?\n'+choices, others[0]?.participantId || '');
                  if (toId) ensureWS(()=>ws.send(JSON.stringify({ type:'host:reassign-player', fromId: b.id, toId, playerId: player.id })));
                };
                td.appendChild(btnRem);
                td.appendChild(btnRe);
              }
            }
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        }
      });

      table.appendChild(tbody);
      wrap.appendChild(table);
    }
  });
}

window.addEventListener('resize', () => renderRosters(rosterCache));

    // === Giocatori (CSV) ===
    // --- helper locali per normalizzare una riga CSV ---
function normalizeKeysFront(obj) {
  const out = {};
  for (const k in obj) {
const nk = k.replace(/^\uFEFF/, '').trim(); // rimuove BOM + spazi
out[nk] = obj[k];
  }
  return out;
}
const ROLE_MAP = { A:'Attaccante', D:'Difensore', C:'Centrocampista', P:'Portiere' };
function canonicalRowFront(row) {
  if (Array.isArray(row) || Object.keys(row).some(k => /^\d+$/.test(k))) {
    const arr = Array.isArray(row)
      ? row
      : Object.keys(row).sort((a, b) => a - b).map(k => row[k]);
    const Nome    = (arr[1]  ?? '').toString().trim();
    const rawRole = (arr[3]  ?? '').toString().trim();
    const Ruolo   = ROLE_MAP[(rawRole || '').toUpperCase()] || rawRole;
    const Squadra = (arr[9]  ?? '').toString().trim();
    const Immagine = (arr[15] ?? '').toString().trim();
    return { Nome, Ruolo, Squadra, ValoreBase: 0, Immagine };
  }
  const r = normalizeKeysFront(row);
  const Nome     = (r.Nome ?? r.nome ?? r.NOME ?? r.Player ?? r.Giocatore ?? '').toString().trim();
  const rawRole  = (r.Ruolo ?? r.ruolo ?? r.Role ?? '').toString().trim();
  const Ruolo    = ROLE_MAP[(rawRole || '').toUpperCase()] || rawRole;
  const Squadra  = (r.Squadra ?? r.squadra ?? r.Team ?? '').toString().trim();
  const VBraw    = (r.ValoreBase ?? r['Valore Base'] ?? r.Base ?? r.base ?? 0);
  const ValoreBase = Number.parseInt(String(VBraw).replace(',', '.'), 10) || 0;
  const Immagine = (r.Immagine ?? r.Image ?? r.Foto ?? r.Photo ?? r.img ?? r.image ?? '').toString().trim();
  return { Nome, Ruolo, Squadra, ValoreBase, Immagine };
}

	function onUploadCsv(){
	  const f = $('csvFile')?.files?.[0];
	  if (!f) { setStatus('Seleziona un CSV', false, true); return; }
	  const fd = new FormData();
	  fd.append('csv', f);

	  fetch('/upload', { method:'POST', body: fd })
		.then(r => r.json())
		.then(j => {
		  if (!j.success) throw new Error(j.error || 'Upload fallito');

		  const raw = Array.isArray(j.players) ? j.players : [];
		  playersCache = raw.map(canonicalRowFront).filter(p => p.Nome);
		  calledPlayers = new Set();

		  // opzionale: id stabile per debug
		  let autoinc = 1;
		  playersCache.forEach(p => { if (!p._id) p._id = `p_${autoinc++}`; });

		  setStatus(`CSV caricato ✅ (${playersCache.length} giocatori)`, true);
		  renderPlayers(); // userà la view
		  nomHydrateTeams();
		  nomHydrateRoles();
		  nomApplyFilters();
		})
		.catch(e => setStatus('Errore upload CSV: '+e.message, false, true));
	}


	
	function hydrateTeamsFilter() {
	  const sel = document.getElementById('playerTeamFilter');
	  if (!sel) return;
	  const cur = sel.value || '';
	  const teams = Array.from(playersTeamsSet).sort((a,b)=> a.localeCompare(b, 'it', {sensitivity:'base'}));
	  sel.innerHTML = `<option value="">Tutte le squadre</option>` +
		teams.map(t => `<option value="${escapeHtml(t)}"${t===cur?' selected':''}>${escapeHtml(t)}</option>`).join('');
	}

	// sicurezza minimale per valori testuali
	function escapeHtml(s=''){
	  return String(s)
		.replaceAll('&','&amp;').replaceAll('<','&lt;')
		.replaceAll('>','&gt;').replaceAll('"','&quot;')
		.replaceAll("'",'&#039;');
	}

	function onPlayersSearchInput(e) {
	  // debounce molto semplice
	  clearTimeout(onPlayersSearchInput._t);
	  onPlayersSearchInput._t = setTimeout(() => {
		playersPage = 1;
		applyPlayersFiltersAndSort();
		renderPlayersPage();
	  }, 120);
	}

	function onPlayersFilterChange() {
	  playersPage = 1;
	  applyPlayersFiltersAndSort();
	  renderPlayersPage();
	}

	function onPlayersPageSizeChange() {
	  const sel = document.getElementById('playerPageSize');
	  playersPageSize = Math.max(1, parseInt(sel.value, 10) || 25);
	  playersPage = 1;
	  renderPlayersPage();
	}

	function onPlayersSort(th) {
	  const key = th?.dataset?.sort || 'Nome';
	  if (playersSortKey === key) {
		playersSortDir = (playersSortDir === 'asc') ? 'desc' : 'asc';
	  } else {
		playersSortKey = key;
		playersSortDir = 'asc';
	  }
	  applyPlayersFiltersAndSort();
	  renderPlayersPage();

	  // feedback visivo minimale nell’header (freccina)
	  const thead = th.closest('thead');
	  if (thead) {
		thead.querySelectorAll('th').forEach(el => el.removeAttribute('data-sortdir'));
		th.setAttribute('data-sortdir', playersSortDir);
	  }
	}

	function playersGoPage(what) {
	  const total = (playersView || []).length;
	  const max   = Math.max(1, Math.ceil(total / Math.max(1, playersPageSize)));

	  if (what === 'first') playersPage = 1;
	  else if (what === 'prev') playersPage = Math.max(1, playersPage - 1);
	  else if (what === 'next') playersPage = Math.min(max, playersPage + 1);
	  else if (what === 'last') playersPage = max;

	  renderPlayersPage();
	}

	function applyPlayersFiltersAndSort(){
	  const q     = (document.getElementById('playerSearch')?.value || '').trim().toLowerCase();
	  const team  = (document.getElementById('playerTeamFilter')?.value || '').trim();
	  const role  = (document.getElementById('playerRoleFilter')?.value || '').trim();
	  const sortK = (document.getElementById('playerSort')?.value || 'name-asc');

	  // 1) filtro
	  playersView = (playersCache || []).filter(p => {
		const nm = (p.Nome || '').toLowerCase();
		const rl = (p.Ruolo || '').toLowerCase();
		const sq = (p.Squadra || '').toLowerCase();

		if (q && !(nm.includes(q) || rl.includes(q) || sq.includes(q))) return false;
		if (team && String(p.Squadra) !== team) return false;
		if (role && String(p.Ruolo).toLowerCase() !== role.toLowerCase()) return false;

		return true;
	  });

	  // 2) ordinamento
	  const collator = new Intl.Collator('it', { sensitivity: 'base' });
	  playersView.sort((a,b) => {
		switch (sortK) {
		  case 'base-asc':  return (a.ValoreBase||0) - (b.ValoreBase||0);
		  case 'base-desc': return (b.ValoreBase||0) - (a.ValoreBase||0);
		  case 'name-desc': return collator.compare(b.Nome||'', a.Nome||'');
		  case 'name-asc':
		  default:          return collator.compare(a.Nome||'', b.Nome||'');
		}
	  });

	  // riparti dalla prima pagina quando cambi filtro/sort
	  playersPage = 1;
	}

	function renderPlayersPage(){
	  const tb = document.getElementById('playersBody');
	  if (!tb) return;
	  tb.innerHTML = '';

	  const total = (playersView || []).length;
	  const max   = Math.max(1, Math.ceil(total / Math.max(1, playersPageSize)));
	  // clamp della pagina corrente, per sicurezza
	  playersPage = Math.min(max, Math.max(1, playersPage));

	  const start = (playersPage - 1) * playersPageSize;
	  const end   = Math.min(total, start + playersPageSize);
	  const slice = playersView.slice(start, end);

	  slice.forEach((p, i) => {
		const rowIndexInView = start + i;
		const nome    = p.Nome || '';
		const ruolo   = p.Ruolo || '';
		const squadra = p.Squadra || '';
		const base    = p.ValoreBase || 0;

		let thumb = '';
		const img = (p.Immagine || '').toString().trim();
		if (img) {
		  const src = img.startsWith('/') ? img :
					  /^https?:\/\//i.test(img) ? `/img-proxy?u=${encodeURIComponent(img)}` : '';
		  if (src) thumb = `<img src="${src}" alt="" style="height:36px;width:auto;border-radius:6px;border:1px solid #eee" onerror="this.style.display='none'">`;
		}

		// stato "già chiamato"
		const isCalled = isPlayerCalled(p);

		const tr = document.createElement('tr');
		if (isCalled) tr.classList.add('tr-called');
		tr.innerHTML = `
		  <td>${rowIndexInView+1}</td>
		  <td style="display:flex;align-items:center;gap:8px;">
			${thumb}
			<span>${escapeHtml(nome)}</span>
			${isCalled ? '<span class="badge-called">chiamato</span>' : ''}
		  </td>
		  <td>${escapeHtml(ruolo)}</td>
		  <td>${escapeHtml(squadra)}</td>
		  <td>${base}</td>
		  <td><button class="btn btn-ghost" data-view-index="${rowIndexInView}">${isCalled ? 'Riavvia' : 'Avvia'}</button></td>
		`;
		tb.appendChild(tr);
	  });

	  // bind
	  tb.querySelectorAll('button[data-view-index]').forEach(btn => {
		btn.addEventListener('click', (e) => {
		  const viewIdx = parseInt(e.currentTarget.getAttribute('data-view-index'), 10);
		  onStartPlayerFromView(viewIdx);
		});
	  });

	  updatePlayersPager(total);
	}

	function updatePlayersPager(total){
	  const pageMax = Math.max(1, Math.ceil(total / Math.max(1, playersPageSize)));
	  const curEl   = document.getElementById('playersPageCur');
	  const maxEl   = document.getElementById('playersPageMax');
	  const countEl = document.getElementById('playersCount');

	  if (curEl)   curEl.textContent   = String(playersPage);
	  if (maxEl)   maxEl.textContent   = String(pageMax);
	  if (countEl) countEl.textContent = String(total);
	}


	function onStartPlayerFromView(viewIndex){
	  const p = playersView[viewIndex];
	  if (!p) { showToast?.('Giocatore non trovato.', 'error'); return; }
	  // marca subito localmente
	  addCalledForPlayerObj(p);

	  // 👉 rerender immediato liste
	  renderPlayersPage();
	  if (typeof renderNomPage === 'function') renderNomPage();

	  ensureWS(()=> ws.send(JSON.stringify({ type:'host:start-player', player: p })));
	}


	// “Avvia” deve puntare all’indice corretto in playersCache, non nella pagina
	function onStartPlayerAbsolute(absIndex) {
	  const p = playersCache[absIndex] || {};
	  addCalledForPlayerObj(p);

	  // 👉 rerender immediato liste
	  renderPlayersPage();
	  if (typeof renderNomPage === 'function') renderNomPage();

	  ensureWS(()=> ws.send(JSON.stringify({ type:'host:start-player', player: p })));
	}


	function renderPlayers() {
	  // 1) ricostruisci l’insieme squadre (per dropdown) e normalizza valore ricerca
	  playersTeamsSet = new Set();
	  for (const p of (playersCache || [])) {
		if (p.Squadra) playersTeamsSet.add(String(p.Squadra));
	  }
	  hydrateTeamsFilter(); // aggiorna <select> squadre

	  // 2) applica filtri + sort
	  applyPlayersFiltersAndSort();

	  // 3) render della pagina corrente
	  renderPlayersPage();
	}



    // === Azioni host/bidder ===
    function onSetTimer(){
      const sec = Math.max(5, parseInt($('timerInp')?.value||'30',10));
      ensureWS(()=> ws.send(JSON.stringify({ type:'host:set-timer', seconds: sec })));
    }
    function onStartItem(){
      const name = ($('itemNameInp')?.value||'').trim() || 'Senza titolo';
      const startPrice = Math.max(0, parseInt($('startPriceInp')?.value||'0',10));
      const role = ($('roleInp')?.value||'').trim();
      const team = ($('teamInp')?.value||'').trim();
      const image = '';
      ensureWS(()=> ws.send(JSON.stringify({ type:'host:start-item', name, startPrice, role, team, image })));
    }
    function onStartPlayer(idx){
      const p = playersCache[idx] || {};
      ensureWS(()=> ws.send(JSON.stringify({ type:'host:start-player', player: p })));
    }
    function onEndItem(){ ensureWS(()=> ws.send(JSON.stringify({ type:'host:end-item' }))); }

    function onBidPlus(delta){
  if (!auctionActive) { showToast('Nessun giocatore in asta.', 'warn'); return; }

  const base = Number(currentPrice) || 0;
  const max  = getMyMaxBid();

  let next = base + delta;
  if (next > max) {
if (max <= base) {
  showToast('Hai raggiunto il tuo limite di puntata.', 'warn');
  return;
}
// aggancia al massimo consentito
next = max;
showToast(`Offerta agganciata al tuo massimo: ${next}`, 'ok', 1800);
  }

  const inp = $('bidAmount');
  if (inp) inp.value = String(next);
  const mob = $('bidAmountMobile');
  if (mob) mob.value = String(next);

  ensureWS(()=> ws.send(JSON.stringify({ type:'bid', amount: next })));
}

function onBidMobilePlus(){
  if (!auctionActive) { showToast('Nessun giocatore in asta.', 'warn'); return; }

  const base = Number(currentPrice) || 0;
  const max  = getMyMaxBid();
  let val = parseInt($('bidAmountMobile')?.value || '', 10);

  if (Number.isFinite(val) && val > base) {
if (val > max) {
  if (max <= base) {
        showToast('Hai raggiunto il tuo limite di puntata.', 'warn');
        return;
  }
  val = max;
  showToast(`Offerta agganciata al tuo massimo: ${val}`, 'ok', 1800);
}
const inp = $('bidAmount');
const mob = $('bidAmountMobile');
if (inp) inp.value = String(val);
if (mob) mob.value = String(val);
ensureWS(()=> ws.send(JSON.stringify({ type:'bid', amount: val })));
  } else {
onBidPlus(1);
  }
}

function onBidCustom(){
  if (!auctionActive) { showToast('Nessun giocatore in asta.', 'warn'); return; }

  const base = Number(currentPrice) || 0;
  const max  = getMyMaxBid();
  let val = parseInt($('bidAmount')?.value||'0',10);

	  if (!Number.isFinite(val) || val <= 0) {
		showToast('Inserisci un importo valido.', 'warn'); return;
	  }
	  if (val <= base) {
		showToast('Devi superare l’offerta corrente.', 'warn'); return;
	  }
	  if (val > max) {
		if (max <= base) {
		  showToast('Hai raggiunto il tuo limite di puntata.', 'warn'); return;
		}
		val = max;
		showToast(`Offerta agganciata al tuo massimo: ${val}`, 'ok', 1800);
	  }

	  ensureWS(()=> ws.send(JSON.stringify({ type:'bid', amount: val })));
	}


	function setBidButtonsEnabled(enabled){
	  // quick-bid
	  document.querySelectorAll('.qbtn').forEach(btn=>{
		btn.disabled = !enabled;
		btn.style.opacity = enabled ? '1' : '0.6';
		btn.style.cursor  = enabled ? 'pointer' : 'not-allowed';
	  });
	  // bottone "Punta" accanto a #bidAmount
	  const customBtn = document.querySelector('#bidAmount + button');
	  if (customBtn) {
		customBtn.disabled = !enabled;
		customBtn.style.opacity = enabled ? '1' : '0.6';
		customBtn.style.cursor  = enabled ? 'pointer' : 'not-allowed';
	  }
	}

	async function loadLogList() {
  try {
    const res = await fetch('/logs/list');
    const j = await res.json();
    const sel = document.getElementById('logFileSelect');
    const btn = document.getElementById('logDownloadBtn');
    if (!sel || !btn) return;

    if (!j.success) throw new Error(j.error || 'Errore elenco log');

    sel.innerHTML = j.files.map(f => `<option value="${f}">${f}</option>`).join('');
    if (j.files.length) {
      btn.href = '/logs/file/' + encodeURIComponent(j.files[0]);
      btn.download = j.files[0];
    } else {
      btn.href = '#';
      btn.removeAttribute('download');
    }

    sel.onchange = () => {
      const name = sel.value;
      btn.href = '/logs/file/' + encodeURIComponent(name);
      btn.download = name;
    };
  } catch (e) {
    showToast('Errore caricamento elenco log: ' + e.message, 'error');
  }
}

// opzionale: carica l’elenco appena il gestore apre la dashboard
document.addEventListener('DOMContentLoaded', () => {
  const mo = new MutationObserver(() => {
    if (document.getElementById('hostCard')?.style.display !== 'none') {
      fetchInvites().catch(err => showToast(err.message, 'error'));
      mo.disconnect();
    }
  });
  mo.observe(document.body, { childList:true, subtree:true });
});



    function onSetBudgets(){
      const cr  = Math.max(0, parseInt($('defCreditsInp')?.value || '0', 10));
      const por = Math.max(0, parseInt($('defPorInp')?.value || '3', 10));
      const dif = Math.max(0, parseInt($('defDifInp')?.value || '8', 10));
      const cen = Math.max(0, parseInt($('defCenInp')?.value || '8', 10));
      const att = Math.max(0, parseInt($('defAttInp')?.value || '6', 10));
      ensureWS(()=> ws.send(JSON.stringify({
type:'host:set-budgets',
credits: cr,
slotsPor: por, slotsDif: dif, slotsCen: cen, slotsAtt: att
      })));
    }

    // === Costruzione UI iniziale (il tuo markup) ===
    function buildUI(){
      const root = document.createElement('div');
      root.className = 'grid';
      root.innerHTML = `
<!-- LOGIN CARD -->
<div class="card login-card" id="loginCard">
  <div class="section">
    <div class="section-title">Entra nell'asta</div>
    <div class="row"><input id="joinName" type="text" placeholder="Il tuo nome" /></div>
    <div class="row">
      <select id="joinRole">
<option value="bidder">Partecipante</option>
<option value="monitor">Monitor esterno</option>
<option value="host">Gestore</option>
      </select>
    </div>
    <div class="row" id="pinRow" style="display:none;">
      <input id="hostPin" type="password" placeholder="PIN gestore" />
    </div>
    <div class="row"><button class="btn btn-primary" id="loginBtn">Entra</button></div>
  </div>
</div>

<!-- HOST CARD -->
<div class="card" id="hostCard" style="display:none;">
		  <!-- Toolbar / stat -->
    <div class="host-toolbar">
          <div id="roundInfo" class="stat" style="margin-left:8px;">
          <div class="stat-label">Round Robin</div>
			  <div class="stat-value">disattivato</div>
			</div>
		  </div>
   <!-- Griglia 2 colonne -->
  <div class="host-grid">
        <!-- Colonna sinistra -->
        <div class="host-col">
          <!-- Controlli -->
          <div class="section">
                <div class="section-title">Controlli</div>
                <div class="host-controls">
                  <select id="roundStrategy" class="btn">
                        <option value="random">Ordine casuale</option>
                        <option value="name">Ordine alfabetico (nome)</option>
                  </select>
                  <button class="btn" onclick="onHostStartRound()">Avvia RR</button>
                  <button class="btn btn-ghost" onclick="onHostStopRound()">Stop RR</button>
                  <button id="btnSkipNominator" class="btn">Salta turno nominatore</button>
                  <button id="btnKickAnon" class="btn btn-danger">Elimina tutti</button>
                  <label style="display:flex; align-items:center; gap:4px;">
                    <input type="checkbox" id="toggleBidderDetails" onchange="onToggleBidderDetails()" />
                    Dettagli bidder
                  </label>
                  <label style="display:flex; align-items:center; gap:4px;">
                    <input type="checkbox" id="toggleBidderRoster" onchange="onToggleBidderRoster()" />
                    Mostra roster ai bidder
                  </label>
                  <button class="btn btn-ghost" onclick="ensureWS(()=>ws.send(JSON.stringify({type:'host:get-users'})))">Aggiorna lista</button>
                  <button class="btn btn-danger" onclick="onEndItem()">Chiudi asta</button>
                </div>
          </div>
          <!-- Configurazione rapida -->
          <div class="section">
                <div class="section-title">Configurazione</div>
                <div class="row">
                  <input id="timerInp" type="number" min="5" value="12" placeholder="Countdown (s)" />
				  <button class="btn btn-primary" onclick="onSetTimer()">Imposta</button>
				</div>

				<div class="subgrid">
				  <div>
					<div class="subtle">Asta manuale</div>
					<div class="row">
					  <input id="itemNameInp" placeholder="Nome giocatore" />
					  <input id="roleInp" placeholder="Ruolo" />
					  <input id="teamInp" placeholder="Squadra" />
					  <input id="startPriceInp" type="number" value="0" placeholder="Base" />
					  <button class="btn" onclick="onStartItem()">Avvia</button>
					</div>
				  </div>

				  <div>
					<div class="subtle">Budget di default</div>

					<!-- Crediti iniziali a tutta larghezza -->
					<div class="row row--credits">
					  <input id="defCreditsInp" type="number" min="0" placeholder="Crediti iniziali" />
					</div>

					<!-- Slot tutti su una riga -->
					<div class="slots-row">
					  <input id="defPorInp" type="number" min="0" placeholder="POR (3)" />
					  <input id="defDifInp" type="number" min="0" placeholder="DIF (8)" />
					  <input id="defCenInp" type="number" min="0" placeholder="CEN (8)" />
					  <input id="defAttInp" type="number" min="0" placeholder="ATT (6)" />
					  <button class="btn" onclick="onSetBudgets()">Applica</button>
					</div>
				  </div>
				</div>
			  </div>

			  <!-- Lista giocatori (con ricerca/filtri/paginazione) -->
				<div class="section">
				  <div class="section-title">Giocatori</div>

				  <!-- Upload CSV -->
				  <div class="row">
					<input id="csvFile" type="file" accept=".csv" />
					<button class="btn" onclick="onUploadCsv()">Carica CSV</button>
				  </div>

				  <!-- Toolbar filtri -->
				  <div class="players-toolbar">
					<input id="playerSearch" type="search" placeholder="Cerca (nome, ruolo, squadra)…" oninput="onPlayersSearchInput(event)" />
					<select id="playerRoleFilter" onchange="onPlayersFilterChange()">
					  <option value="">Tutti i ruoli</option>
					  <option value="Portiere">Portiere</option>
					  <option value="Difensore">Difensore</option>
					  <option value="Centrocampista">Centrocampista</option>
					  <option value="Attaccante">Attaccante</option>
					</select>
					<select id="playerTeamFilter" onchange="onPlayersFilterChange()">
					  <option value="">Tutte le squadre</option>
					</select>
					<span class="players-stats">
					  <span id="playersCount">0</span> elementi
					</span>
					<span class="players-spacer"></span>
					<label>
					  Per pagina
					  <select id="playerPageSize" onchange="onPlayersPageSizeChange()">
						<option>10</option>
						<option selected>25</option>
						<option>50</option>
						<option>100</option>
					  </select>
					</label>
				  </div>

				  <div class="table-wrap">
					<table>
					  <thead>
						<tr>
<th style="width:64px">#</th>
<th data-sort="Nome"     onclick="onPlayersSort(this)">Nome</th>
<th data-sort="Ruolo"    onclick="onPlayersSort(this)">Ruolo</th>
<th data-sort="Squadra"  onclick="onPlayersSort(this)">Squadra</th>
<th data-sort="ValoreBase" onclick="onPlayersSort(this)">Base</th>
<th>Azioni</th>
						</tr>
					  </thead>
					  <tbody id="playersBody"></tbody>
					</table>
				  </div>

				  <!-- Paginazione -->
				  <div class="players-pager">
					<button class="btn" onclick="playersGoPage('first')">«</button>
					<button class="btn" onclick="playersGoPage('prev')">‹</button>
					<span>Pagina <b id="playersPageCur">1</b> / <b id="playersPageMax">1</b></span>
					<button class="btn" onclick="playersGoPage('next')">›</button>
					<button class="btn" onclick="playersGoPage('last')">»</button>
				  </div>
				</div>

			</div>

			<!-- Colonna destra -->
			<div class="host-col">
			  <!-- Asta corrente (dettaglio) -->
			  <div class="section">
                <div class="section-title">Asta corrente</div>
                <div class="pill-row">
                  <span class="pill-host"><b>Giocatore</b> <span id="itemNameHost">—</span></span>
                  <span class="pill-host"><b>Ruolo</b> <span id="itemRoleHost">—</span></span>
                  <span class="pill-host"><b>Squadra</b> <span id="itemTeamHost">—</span></span>
                  <span class="pill-host"><b>Countdown</b> <span id="countdownHost">—</span></span>
                  <span class="pill-host"><b>Prezzo</b> <span id="itemPriceHost">0</span></span>
                  <span class="pill-host"><b>Top bidder</b> <span id="itemBidderHost">—</span></span>
                  <span class="pill-host"><b>Countdown predef.</b> <span id="timerCur">12</span>s</span>
                </div>
			  </div>
			</div>

			<!-- FULL WIDTH: Utenti -->
        <div class="section full">
          <div class="section-title">Utenti</div>
          <div class="table-wrap">
                <table>
                  <thead>
                        <tr>
                          <th>Nome</th><th>Ruolo</th><th>Stato</th><th>Crediti</th><th>Spesi</th><th>POR</th><th>DIF</th><th>CEN</th><th>ATT</th><th>Azioni</th>
                        </tr>
                  </thead>
                  <tbody id="users"></tbody>
                </table>
          </div>
        </div>
        <div class="section full">
          <div id="rosterCard" class="roster-container">
            <div class="roster-header">Rosters
              <select id="rosterViewMode" class="roster-view-select">
                <option value="auto">Auto</option>
                <option value="table">Tabella</option>
                <option value="cards">Card</option>
              </select>
            </div>
            <div id="rosterList"></div>
          </div>
        </div>
        <div class="section full" id="invitesSection">
          <div class="section-title">Inviti</div>

			  <!-- Crea invito PRIMA che l'utente entri -->
			  <div class="row">
				<input id="invNameNew" placeholder="Nome partecipante" />
				<select id="invRoleNew">
				  <option value="bidder" selected>Partecipante</option>
				  <option value="monitor">Monitor</option>
				  <option value="host">Gestore</option>
				</select>
				<button class="btn" id="inviteCreateByNameBtn">Crea da nome</button>

				<span style="margin:0 8px;opacity:.5">oppure</span>

				<!-- (facoltativo) crea da utente già collegato -->
				<select id="inviteUserSelect"></select>
				<button class="btn" id="inviteCreateBtn">Crea per utente</button>

				<span class="players-spacer"></span>
				<button class="btn btn-ghost" id="inviteRefreshBtn">Aggiorna</button>
			  </div>

			  <div class="table-wrap">
				<table>
				  <thead>
					<tr><th>Partecipante</th><th>Link</th><th>Azioni</th></tr>
				  </thead>
				  <tbody id="invitesBody"></tbody>
				</table>
			  </div>
			</div>

			<!-- FULL WIDTH: Log -->
			<div class="section full">
			  <div class="section-title">Log</div>
			  <div class="table-wrap table-wrap--log">
				<table>
				  <thead>
					<tr><th>Ora</th><th>Evento</th><th>Oggetto</th><th>Utente</th><th>Puntata</th><th>Vincitore</th></tr>
				  </thead>
				  <tbody id="logBody"></tbody>
				</table>
			  </div>
			  <div class="section full">
				  <div class="section-title">Download log</div>
				  <div class="row">
					<select id="logFileSelect" style="min-width:240px"></select>
					<a id="logDownloadBtn" class="btn" href="#" download>Scarica</a>
					<button class="btn btn-ghost" onclick="loadLogList()">Aggiorna elenco</button>
				  </div>
				</div>
			</div>
		  </div>
</div>


<div id="mobileAuctionOverlay">
  <div class="mobile-overlay-top">
    <div class="mobile-overlay-left">
      <div><span id="itemNameBidMobile">—</span></div>
      <div>Prezzo: <b id="itemPriceBidMobile">0</b> — da <b id="itemBidderBidMobile">—</b></div>
      <div>Countdown: <b id="countdownBidMobile">—</b></div>
    </div>
    <div class="mobile-overlay-right">
      <img id="itemImgBidMobile" class="player-img" src="/placeholder.jpg" alt="Immagine giocatore">
    </div>
  </div>
  <div id="bidBottomBar" class="bid-bottom-bar">
    <input id="bidAmountMobile" type="text" inputmode="numeric" />
    <button class="btn btn-bidMobile" aria-label="Aumenta" onclick="onBidMobilePlus()">+</button>
  </div>
</div>

  <div class="card" id="bidderCard" style="display:none;">
  <h2>Partecipante</h2>
  <div id="bidderSecondaryInfo" class="bidder-secondary">
    <div id="bidderMetaBox" class="info-box">
      <div id="bidderCountdownRow">Countdown: <b id="countdownBid">—</b></div>
      <div id="bidderRoleRow" style="display:none;">Ruolo: <b id="itemRoleBid">—</b></div>
      <div id="bidderTeamRow" style="display:none;">Squadra: <b id="itemTeamBid">—</b></div>
      <div id="bidderLast3Row" style="display:none;">Ultimi 3: <b id="itemLast3Bid">—</b></div>
    </div>
  </div>
  <div id="rosterCardBidder" class="roster-container">
    <div class="roster-header">Rosters
      <select id="rosterViewModeBidder" class="roster-view-select">
        <option value="auto">Auto</option>
        <option value="table">Tabella</option>
        <option value="cards">Card</option>
      </select>
    </div>
    <div id="rosterListBidder"></div>
  </div>
  <div class="row" id="bidInputRow">
    <input id="bidAmount" type="number" min="1" placeholder="Offerta precisa" />
    <button onclick="onBidCustom()">Punta</button>
  </div>
  <div class="quick-bid-wrap">
    <div class="quick-bid" role="toolbar" aria-label="Offerte rapide">
      <button class="qbtn q1"  onclick="onBidPlus(1)"  aria-label="Aggiungi 1">
<span class="chip" aria-hidden="true">
  <i class="fa-solid fa-plus"></i>
</span><span class="label">+1</span>
      </button>
    </div>
  </div>
</div>
 <!-- Bidder: modale scelta giocatore -->
		<div id="nominateModal" style="display:none; position:fixed; inset:0; z-index:9998;">
		  <div style="position:absolute; inset:0; background:rgba(0,0,0,.45)" onclick="closeNominateModal()"></div>
		  <div style="position:relative; z-index:1; max-width:1000px; width:92vw; margin:5vh auto; background:#fff; border-radius:12px; padding:16px; box-shadow:0 20px 60px rgba(0,0,0,.25);">
			<div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:10px;">
			  <h3 style="margin:0;">Scegli un giocatore</h3>
			  <button class="btn" onclick="closeNominateModal()">Chiudi</button>
			</div>

			<!-- Toolbar filtri -->
			<div class="players-toolbar">
			  <input id="nomSearch" type="search" placeholder="Cerca (nome, ruolo, squadra)…" oninput="onNomSearchInput(event)" />
			  <select id="nomRoleFilter" onchange="onNomFiltersChange()">
				<option value="">Tutti i ruoli</option>
				<option value="Portiere">Portiere</option>
				<option value="Difensore">Difensore</option>
				<option value="Centrocampista">Centrocampista</option>
				<option value="Attaccante">Attaccante</option>
			  </select>
			  <select id="nomTeamFilter" onchange="onNomFiltersChange()">
				<option value="">Tutte le squadre</option>
			  </select>
			  <span><span id="nomCount">0</span> elementi</span>
			  <span class="players-spacer"></span>
			  <label>Per pagina
				<select id="nomPageSize" onchange="onNomPageSizeChange()">
				  <option>10</option>
				  <option selected>25</option>
				  <option>50</option>
				  <option>100</option>
				</select>
			  </label>
			</div>

			<div class="table-wrap" style="max-height:60vh;">
			  <table>
				<thead>
				  <tr>
					<th style="width:64px">#</th>
					<th>Nome</th>
					<th>Ruolo</th>
					<th>Squadra</th>
					<th>Base</th>
					<th style="width:120px">Azioni</th>
				  </tr>
				</thead>
				<tbody id="nomBody"></tbody>
			  </table>
			</div>

			<!-- Paginazione -->
			<div class="players-pager">
			  <button class="btn" onclick="nomGoPage('first')">«</button>
			  <button class="btn" onclick="nomGoPage('prev')">‹</button>
			  <span>Pagina <b id="nomPageCur">1</b> / <b id="nomPageMax">1</b></span>
			  <button class="btn" onclick="nomGoPage('next')">›</button>
			  <button class="btn" onclick="nomGoPage('last')">»</button>
			</div>
		  </div>
		</div>
 <div id="monitorCard" class="card" style="display:none; text-align:center">
		 <div class="monitor-topbar">
			  <button id="btnFullscreen" class="btn btn-ghost" type="button">Schermo intero</button>
			</div>
  <div class="monitor-stage">
			  <div class="mon-wrap">
				<div class="mon-card">
				  <div class="mon-title">
					<div id="monName" class="mon-name">—</div>
					<div class="mon-meta">
					  <span class="pill"><span class="dot"></span><b id="monRole">—</b></span>
					  <span class="pill"><span class="dot"></span>Squadra <b id="monTeam">—</b></span>
					</div>
				  </div>

				  <div class="mon-price-wrap">
					<div class="mon-ring" id="monRing">
					  <div class="mon-time" id="monTime">—</div>
					</div>
					<div class="mon-price" id="monPrice">0</div>
				  </div>

				  <div class="last3" id="last3Chips">
				  </div>
				</div>

				<div class="mon-card" style="display:grid; place-items:center;">
				  <img id="monImg" class="mon-img" alt="Immagine giocatore" src="/placeholder.jpg">
				</div>
			  </div>
			</div>
</div>
      `;
      document.body.appendChild(root);
      ['rosterViewMode', 'rosterViewModeBidder'].forEach(id => {
        const rosterSel = $(id);
        if (rosterSel) {
          rosterSel.addEventListener('change', () => {
            const v = rosterSel.value;
            rosterViewOverride = v === 'auto' ? null : v;
            renderRosters(rosterCache);
          });
        }
      });
          // Stato iniziale bidder: bottoni disabilitati e righe nascoste
          setBidButtonsEnabled(false);
  const metaRowInit = document.getElementById('bidderMetaRow');
  const cntRowInit  = document.getElementById('bidderCountdownRow');
  const roleRowInit = document.getElementById('bidderRoleRow');
  const teamRowInit = document.getElementById('bidderTeamRow');
  const last3RowInit = document.getElementById('bidderLast3Row');
  if (metaRowInit) metaRowInit.style.display = 'none';
  if (cntRowInit)  cntRowInit.style.display  = 'none';
  if (roleRowInit) roleRowInit.style.display = 'none';
  if (teamRowInit) teamRowInit.style.display = 'none';
  if (last3RowInit) last3RowInit.style.display = 'none';

  const bidDesktop = document.getElementById('bidAmount');
  const bidMobile  = document.getElementById('bidAmountMobile');
  const syncBid = (src) => {
const val = parseInt(src.value || '0', 10) || 0;
if (bidDesktop && src !== bidDesktop) bidDesktop.value = String(val);
if (bidMobile  && src !== bidMobile)  bidMobile.value  = String(val);
  };
  bidDesktop?.addEventListener('input', e => syncBid(e.target));
  bidMobile?.addEventListener('input', e => syncBid(e.target));
  bidMobile?.addEventListener('focus', e => e.target.select());
    }

    // Esporta solo le funzioni usate dai bottoni nel DOM
    window.onSetTimer = onSetTimer;
    window.onStartItem = onStartItem;
    window.onStartPlayer = onStartPlayer;
    window.onEndItem = onEndItem;
    window.onBidPlus = onBidPlus;
    window.onBidMobilePlus = onBidMobilePlus;
    window.onBidCustom = onBidCustom;
    window.onUploadCsv = onUploadCsv;
    window.onSetBudgets = onSetBudgets;
window.onHostStartRound = onHostStartRound;
window.onHostStopRound  = onHostStopRound;
window.onToggleBidderDetails = onToggleBidderDetails;
window.onToggleBidderRoster = onToggleBidderRoster;

    // === Info panel controls ===
    document.addEventListener('DOMContentLoaded', () => {
      const panel = document.getElementById('infoPanel');
      const overlay = document.getElementById('infoOverlay');
      const closeBtn = document.getElementById('closeInfoPanel');
      const sections = panel.querySelectorAll('.panel-section');
      let active = null;

      const mobileOverlay = document.getElementById('mobileAuctionOverlay');
      function updateMobileOverlayHeight() {
        const isHidden = !mobileOverlay || window.getComputedStyle(mobileOverlay).display === 'none';
        if (isHidden) {
          document.documentElement.style.removeProperty('--overlay-height');
          return;
        }
        const h = mobileOverlay.offsetHeight;
        document.documentElement.style.setProperty('--overlay-height', `${h}px`);
      }

      updateMobileOverlayHeight();
      window.addEventListener('resize', updateMobileOverlayHeight);
      if (mobileOverlay) {
        const mobObserver = new MutationObserver(updateMobileOverlayHeight);
        mobObserver.observe(mobileOverlay, { childList: true, subtree: true, attributes: true });
      }

      function updateOverlayPadding() {
        const isHidden = !overlay || window.getComputedStyle(overlay).display === 'none';
        if (isHidden) {
          document.body.classList.remove('info-overlay-active');
          document.body.style.removeProperty('--info-overlay-height');
          return;
        }
        const height = overlay.offsetHeight;
        document.body.style.setProperty('--info-overlay-height', `${height}px`);
        document.body.classList.add('info-overlay-active');
      }

      updateOverlayPadding();
      window.addEventListener('resize', updateOverlayPadding);
      const overlayObserver = new MutationObserver(updateOverlayPadding);
      if (overlay) overlayObserver.observe(overlay, { attributes: true, attributeFilter: ['style', 'class'] });

      function openPanel(id) {
sections.forEach(sec => {
  const match = sec.id === id;
  sec.classList.toggle('active', match);
  if (match) active = id;
});
document.body.classList.add('info-panel-open');
      }

      function closePanel() {
document.body.classList.remove('info-panel-open');
sections.forEach(sec => sec.classList.remove('active'));
active = null;
      }

      overlay.addEventListener('click', (e) => {
const btn = e.target.closest('button[data-target]');
if (!btn) return;
const target = btn.getAttribute('data-target');
if (active === target && document.body.classList.contains('info-panel-open')) {
  closePanel();
} else {
  openPanel(target);
}
      });
      closeBtn.addEventListener('click', closePanel);

      let startX = 0;
      panel.addEventListener('touchstart', e => { startX = e.touches[0].clientX; });
      panel.addEventListener('touchend', e => {
const dx = e.changedTouches[0].clientX - startX;
if (dx > 50) closePanel();
      });

      renderProfile();
      renderHistory();
      renderRosters(rosterCache);
    });
