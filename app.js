"use strict";

const GENRE_COLOR = { M: "#3b82f6", F: "#ec4899", X: "#8b5cf6" };
const GENRE_LABEL = { M: "Masculin", F: "Féminin", X: "Mixte" };
const MONTHS_FR = ["", "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
  "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];

let allTournaments = [];
let filters = { genre: "", serie: "", monthFrom: "", monthTo: "" };
let activeId = null;
let map, markers = [];

// ── Map init ──────────────────────────────────────────────
const maplibregl = window.maplibregl;
map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/bright",
  center: [2.3, 46.8],
  zoom: 5.5,
});
map.addControl(new maplibregl.NavigationControl(), "top-right");

// ── Load data ─────────────────────────────────────────────
fetch("data/tournaments.json")
  .then((r) => r.json())
  .then((data) => {
    allTournaments = data;
    populateSerieFilter();
    applyFilters();
    setLastUpdated();
  })
  .catch(() => {
    document.getElementById("count-label").textContent = "Erreur de chargement.";
  });

// ── Filters ───────────────────────────────────────────────
function populateSerieFilter() {
  const series = [...new Set(allTournaments.map((t) => t.serie))].sort();
  const sel = document.getElementById("filter-serie");
  series.forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    sel.appendChild(opt);
  });
}

function getFiltered() {
  return allTournaments.filter((t) => {
    if (filters.genre && t.genre_code !== filters.genre) return false;
    if (filters.serie && t.serie !== filters.serie) return false;
    if (filters.monthFrom || filters.monthTo) {
      const month = t.date_start ? parseInt(t.date_start.split("-")[1], 10) : null;
      if (!month) return false;
      if (filters.monthFrom && month < parseInt(filters.monthFrom, 10)) return false;
      if (filters.monthTo && month > parseInt(filters.monthTo, 10)) return false;
    }
    return true;
  });
}

function applyFilters() {
  const filtered = getFiltered();
  renderList(filtered);
  renderMarkers(filtered);
  document.getElementById("count-label").textContent =
    `${filtered.length} tournoi${filtered.length !== 1 ? "s" : ""} affiché${filtered.length !== 1 ? "s" : ""}`;
}

// ── Genre buttons ──────────────────────────────────────────
document.getElementById("filter-genre").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  document.querySelectorAll("#filter-genre button").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  filters.genre = btn.dataset.value;
  applyFilters();
});

document.getElementById("filter-serie").addEventListener("change", (e) => {
  filters.serie = e.target.value;
  applyFilters();
});

document.getElementById("filter-month-from").addEventListener("change", (e) => {
  filters.monthFrom = e.target.value;
  applyFilters();
});

document.getElementById("filter-month-to").addEventListener("change", (e) => {
  filters.monthTo = e.target.value;
  applyFilters();
});

document.getElementById("reset-filters").addEventListener("click", () => {
  filters = { genre: "", serie: "", monthFrom: "", monthTo: "" };
  document.querySelectorAll("#filter-genre button").forEach((b) => b.classList.remove("active"));
  document.querySelector('#filter-genre button[data-value=""]').classList.add("active");
  document.getElementById("filter-serie").value = "";
  document.getElementById("filter-month-from").value = "";
  document.getElementById("filter-month-to").value = "";
  applyFilters();
});

// ── List rendering ─────────────────────────────────────────
function formatDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${parseInt(d)} ${MONTHS_FR[parseInt(m)]} ${y}`;
}

function renderList(tournaments) {
  const ul = document.getElementById("tournament-list");
  ul.innerHTML = "";
  if (!tournaments.length) {
    ul.innerHTML = '<li style="color:#94a3b8;font-size:0.8rem;padding:12px">Aucun tournoi pour ces critères.</li>';
    return;
  }
  // Sort by date
  const sorted = [...tournaments].sort((a, b) =>
    (a.date_start || "").localeCompare(b.date_start || "")
  );
  sorted.forEach((t) => {
    const li = document.createElement("li");
    li.dataset.id = t.id;
    if (t.id === activeId) li.classList.add("active");
    li.innerHTML = `
      <div class="t-name">${escapeHtml(t.name)}</div>
      <div class="t-meta">
        <span class="badge badge-${t.genre_code}">${GENRE_LABEL[t.genre_code] || t.genre}</span>
        <span>${formatDate(t.date_start)}</span>
        <span>${escapeHtml(t.city || "")}</span>
      </div>`;
    li.addEventListener("click", () => selectTournament(t));
    ul.appendChild(li);
  });
}

// ── Map markers ────────────────────────────────────────────
function clearMarkers() {
  markers.forEach((m) => m.remove());
  markers = [];
}

function renderMarkers(tournaments) {
  clearMarkers();
  const withCoords = tournaments.filter((t) => t.lat != null && t.lon != null);

  // Group by exact coordinates
  const groups = new Map();
  withCoords.forEach((t) => {
    const key = `${t.lat},${t.lon}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  });

  groups.forEach((group, key) => {
    const [lat, lon] = key.split(",").map(Number);
    const multi = group.length > 1;

    // Use genre color if all same genre, else neutral
    const genres = [...new Set(group.map((t) => t.genre_code))];
    const color = genres.length === 1 ? (GENRE_COLOR[genres[0]] || "#6b7280") : "#475569";

    const el = document.createElement("div");
    el.className = "marker";

    const dot = document.createElement("div");
    if (multi) {
      dot.style.cssText = `
        width:22px; height:22px; border-radius:50%;
        background:${color}; border:2px solid #fff;
        box-shadow:0 1px 4px rgba(0,0,0,0.3);
        cursor:pointer; transition: transform 0.15s;
        display:flex; align-items:center; justify-content:center;
        font-size:11px; font-weight:700; color:#fff;
        font-family: system-ui, sans-serif;
      `;
      dot.textContent = group.length;
    } else {
      dot.style.cssText = `
        width:14px; height:14px; border-radius:50%;
        background:${color}; border:2px solid #fff;
        box-shadow:0 1px 4px rgba(0,0,0,0.3);
        cursor:pointer; transition: transform 0.15s;
      `;
    }
    el.appendChild(dot);

    el.addEventListener("mouseenter", () => (dot.style.transform = "scale(1.5)"));
    el.addEventListener("mouseleave", () => {
      const isActive = group.some((t) => t.id === activeId);
      dot.style.transform = isActive ? "scale(1.6)" : "scale(1)";
    });

    const marker = new maplibregl.Marker({ element: el })
      .setLngLat([lon, lat])
      .addTo(map);

    el.addEventListener("click", () => {
      if (multi) {
        map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 9), duration: 600 });
        showMultiPopup(group);
      } else {
        selectTournament(group[0]);
      }
    });

    markers.push(marker);
  });
}

// ── Select tournament ──────────────────────────────────────
function selectTournament(t) {
  activeId = t.id;

  // Highlight list item
  document.querySelectorAll("#tournament-list li").forEach((li) => {
    li.classList.toggle("active", li.dataset.id === t.id);
  });
  // Scroll list item into view
  const activeLi = document.querySelector(`#tournament-list li[data-id="${t.id}"]`);
  if (activeLi) activeLi.scrollIntoView({ behavior: "smooth", block: "nearest" });

  // Fly to marker
  if (t.lat != null) {
    map.flyTo({ center: [t.lon, t.lat], zoom: Math.max(map.getZoom(), 9), duration: 600 });
  }

  // Show popup
  showPopup(t);
}

// ── Popup ──────────────────────────────────────────────────
const popup = document.getElementById("popup");
document.getElementById("popup-close").addEventListener("click", closePopup);

function showPopup(t) {
  document.getElementById("popup-name").textContent = t.name;
  const dateStr =
    t.date_start === t.date_end
      ? formatDate(t.date_start)
      : `${formatDate(t.date_start)} → ${formatDate(t.date_end)}`;

  document.getElementById("popup-details").innerHTML = `
    <div class="row"><span class="lbl">Genre</span><span><span class="badge badge-${t.genre_code}">${GENRE_LABEL[t.genre_code] || t.genre}</span></span></div>
    <div class="row"><span class="lbl">Niveau</span><span>${escapeHtml(t.serie)}</span></div>
    <div class="row"><span class="lbl">Date</span><span>${dateStr}</span></div>
    <div class="row"><span class="lbl">Ville</span><span>${escapeHtml(t.city || "—")}</span></div>
    ${t.address ? `<div class="row"><span class="lbl">Lieu</span><span>${escapeHtml(t.address)}</span></div>` : ""}
  `;
  popup.classList.remove("hidden");
}

function showMultiPopup(group) {
  document.getElementById("popup-name").textContent =
    `${group.length} tournois — ${escapeHtml(group[0].city || "")}`;

  const details = document.getElementById("popup-details");
  details.innerHTML = group.map((t, i) => `
    <div class="multi-item" data-id="${t.id}" style="
      cursor:pointer; padding:6px 0;
      ${i < group.length - 1 ? "border-bottom:1px solid #f1f5f9;" : ""}
    ">
      <div style="font-weight:600; font-size:0.82rem; color:#1e293b; line-height:1.3">${escapeHtml(t.name)}</div>
      <div style="display:flex; gap:6px; margin-top:3px; align-items:center;">
        <span class="badge badge-${t.genre_code}">${GENRE_LABEL[t.genre_code] || t.genre}</span>
        <span style="font-size:0.72rem; color:#64748b">${formatDate(t.date_start)}</span>
      </div>
    </div>
  `).join("");

  details.querySelectorAll(".multi-item").forEach((item) => {
    const tournament = group.find((t) => t.id === item.dataset.id);
    item.addEventListener("click", () => selectTournament(tournament));
  });

  popup.classList.remove("hidden");
}

function closePopup() {
  popup.classList.add("hidden");
  activeId = null;
  document.querySelectorAll("#tournament-list li").forEach((li) => li.classList.remove("active"));
}

// ── Last updated ───────────────────────────────────────────
function setLastUpdated() {
  // Try to get file modification via response headers is not possible with fetch cache
  // Use build timestamp injected by scraper if available
  const el = document.getElementById("last-updated");
  const now = new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  el.textContent = `Données du ${now}`;
}

// ── Utility ────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
