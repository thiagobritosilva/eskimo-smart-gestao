import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export interface MapPoint {
  id: string; latitude: number; longitude: number; accuracy?: number | null;
  title: string; subtitle?: string; color: string; outside?: boolean;
}
export interface MapStore { latitude: number; longitude: number; radiusMeters: number }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/**
 * Mapa das marcações de ponto (OpenStreetMap). Cada ponto mostra quem, qual marcação e quando;
 * o círculo claro é a precisão do GPS; o círculo tracejado é o raio da loja (quando configurado).
 */
export function PunchMap({ points, store, focusId, height = 340 }: { points: MapPoint[]; store?: MapStore | null; focusId?: string | null; height?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layers = useRef<L.LayerGroup | null>(null);
  const markers = useRef<Map<string, L.CircleMarker>>(new Map());

  useEffect(() => {
    if (!el.current || map.current) return;
    map.current = L.map(el.current, { scrollWheelZoom: false, attributionControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      // a política do OpenStreetMap exige identificar o site de origem; o sistema todo usa "no-referrer",
      // então só as imagens do mapa enviam a ORIGEM (https://dominio/ — sem caminho nem dados da página)
      referrerPolicy: 'strict-origin-when-cross-origin',
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
    }).addTo(map.current);
    layers.current = L.layerGroup().addTo(map.current);
    // dentro de janelas (modal) o tamanho só é conhecido depois da animação
    const t = setTimeout(() => map.current?.invalidateSize(), 250);
    return () => { clearTimeout(t); map.current?.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    const m = map.current; const g = layers.current;
    if (!m || !g) return;
    g.clearLayers(); markers.current.clear();
    const bounds: L.LatLngExpression[] = [];
    if (store) {
      L.circle([store.latitude, store.longitude], { radius: store.radiusMeters, color: '#b60000', weight: 1.5, dashArray: '6 6', fillOpacity: 0.04 })
        .bindTooltip(`Loja (raio de ${store.radiusMeters} m)`).addTo(g);
      bounds.push([store.latitude, store.longitude]);
    }
    for (const p of points) {
      if (p.accuracy && p.accuracy > 0 && p.accuracy < 2000) {
        L.circle([p.latitude, p.longitude], { radius: p.accuracy, color: p.color, weight: 0, fillOpacity: 0.12, interactive: false }).addTo(g);
      }
      const mk = L.circleMarker([p.latitude, p.longitude], {
        radius: 8, color: p.outside ? '#dc2626' : '#ffffff', weight: p.outside ? 3 : 2, fillColor: p.color, fillOpacity: 1,
      }).bindPopup(`<b>${esc(p.title)}</b>${p.subtitle ? `<br>${esc(p.subtitle)}` : ''}${p.accuracy ? `<br>Precisão do GPS: ±${Math.round(p.accuracy)} m` : ''}${p.outside ? '<br><b style="color:#dc2626">Fora do raio da loja</b>' : ''}<br><a href="https://www.google.com/maps?q=${p.latitude},${p.longitude}" target="_blank" rel="noreferrer">Abrir no Google Maps</a>`)
        .addTo(g);
      markers.current.set(p.id, mk);
      bounds.push([p.latitude, p.longitude]);
    }
    if (bounds.length === 1) m.setView(bounds[0]!, 17);
    else if (bounds.length > 1) m.fitBounds(L.latLngBounds(bounds), { padding: [30, 30], maxZoom: 17 });
    else m.setView([-14.235, -51.925], 4); // Brasil, sem pontos
  }, [points, store]);

  useEffect(() => {
    if (!focusId) return;
    const mk = markers.current.get(focusId);
    if (mk && map.current) { map.current.setView(mk.getLatLng(), 18); mk.openPopup(); }
  }, [focusId, points]);

  return <div ref={el} style={{ height }} className="z-0 w-full overflow-hidden rounded-xl border border-slate-200" />;
}

export const KIND_COLOR: Record<string, string> = { entrada: '#059669', saida_almoco: '#d97706', volta_almoco: '#0284c7', saida: '#475569', entrada_extra: '#7c3aed', saida_extra: '#a855f7' };
