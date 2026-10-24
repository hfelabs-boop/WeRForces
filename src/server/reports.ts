// After-action review exports: CSV tables and a printable PDF report.

import type { AarReport } from '../shared/recording.js';
import { FORCE_NAMES, type ForceId, type SimEvent } from '../shared/types.js';
import { PdfDoc } from './pdf.js';

const csv = (v: unknown) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const rows = (head: string[], body: unknown[][]) => [head, ...body].map((r) => r.map(csv).join(',')).join('\n') + '\n';

export function attachment(name: string): Record<string, string> {
  return { 'Content-Disposition': `attachment; filename="${name}"` };
}

export function eventsCsv(_report: AarReport, events: SimEvent[]): string {
  return rows(
    ['time', 'kind', 'text', 'entity', 'target'],
    events.map((e) => [Math.round(e.time * 10) / 10, e.kind, e.text, e.entityId, e.targetId]),
  );
}

export function killsCsv(r: AarReport, weaponName: (id: string) => string): string {
  return rows(
    ['time', 'victim_id', 'victim', 'victim_force', 'killer_id', 'killer', 'weapon'],
    r.kills.map((k) => [Math.round(k.time * 10) / 10, k.victimId, k.victim, FORCE_NAMES[k.victimForce], k.killerId, k.killer, k.weaponId ? weaponName(k.weaponId) : '']),
  );
}

export function strengthCsv(r: AarReport): string {
  const forces = r.forces.map((f) => f.force);
  return rows(
    ['time', ...forces.map((f) => `${FORCE_NAMES[f].toLowerCase()}_alive`)],
    r.strength.map((s) => [Math.round(s.time), ...forces.map((f) => s.alive[f] ?? 0)]),
  );
}

const fmt = (t: number) => {
  const s = Math.max(0, Math.floor(t));
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

const COLORS: Record<ForceId, [number, number, number]> = { 0: [160, 140, 0], 1: [20, 110, 220], 2: [210, 40, 40], 3: [30, 140, 30] };

/** The after-action report as a PDF: summary, strength chart, kills, weapons, bookmarks. */
export function reportPdf(r: AarReport, weaponName: (id: string) => string): Uint8Array {
  const pdf = new PdfDoc();
  const left = 50;
  const right = pdf.width - 50;
  let y = 60;
  const need = (h: number) => {
    if (y + h > pdf.height - 50) {
      pdf.addPage();
      y = 60;
    }
  };
  const table = (head: string[], widths: number[], body: string[][]) => {
    need(30);
    let x = left;
    head.forEach((c, i) => {
      pdf.text(x, y, c, 9, true);
      x += widths[i];
    });
    y += 4;
    pdf.line(left, y, right, y, [120, 120, 120]);
    y += 12;
    for (const row of body) {
      need(14);
      x = left;
      row.forEach((c, i) => {
        const max = Math.floor(widths[i] / (9 * 0.5));
        pdf.text(x, y, c.length > max ? `${c.slice(0, max - 1)}…` : c, 9);
        x += widths[i];
      });
      y += 13;
    }
    y += 8;
  };

  pdf.text(left, y, 'After-action report', 18, true);
  y += 20;
  pdf.text(left, y, r.scenarioName, 12);
  y += 16;
  pdf.text(left, y, `${fmt(r.start)} to ${fmt(r.end)}  ·  ${r.frames} frames  ·  ${r.detections} detections  ·  ${r.kills.length} kills`, 9, false, [90, 90, 90]);
  y += 24;

  table(
    ['Force', 'Start', 'End', 'Losses', 'Kills', 'Rounds fired'],
    [110, 70, 70, 70, 70, 100],
    r.forces.map((f) => [FORCE_NAMES[f.force], String(f.start), String(f.end), String(f.losses), String(f.kills), String(f.shots)]),
  );

  // Strength over time.
  if (r.strength.length > 1) {
    need(190);
    pdf.text(left, y, 'Strength over time', 12, true);
    y += 12;
    const top = y;
    const H = 150;
    const W = right - left - 40;
    const max = Math.max(1, ...r.forces.map((f) => f.start));
    const t0 = r.strength[0].time;
    const t1 = Math.max(t0 + 1, r.strength[r.strength.length - 1].time);
    const px = (t: number) => left + 30 + ((t - t0) / (t1 - t0)) * W;
    const py = (v: number) => top + H - (v / max) * H;
    pdf.line(left + 30, top, left + 30, top + H, [150, 150, 150]);
    pdf.line(left + 30, top + H, left + 30 + W, top + H, [150, 150, 150]);
    pdf.text(left, top + 8, String(max), 8, false, [90, 90, 90]);
    pdf.text(left + 18, top + H, '0', 8, false, [90, 90, 90]);
    pdf.text(left + 30, top + H + 12, fmt(t0), 8, false, [90, 90, 90]);
    pdf.text(left + 30 + W - 40, top + H + 12, fmt(t1), 8, false, [90, 90, 90]);
    for (const f of r.forces) {
      pdf.polyline(
        r.strength.map((s) => [px(s.time), py(s.alive[f.force] ?? 0)] as [number, number]),
        COLORS[f.force],
        1.5,
      );
      const last = r.strength[r.strength.length - 1].alive[f.force] ?? 0;
      pdf.text(px(t1) + 4, py(last) + 3, FORCE_NAMES[f.force], 8, true, COLORS[f.force]);
    }
    y = top + H + 30;
  }

  need(40);
  pdf.text(left, y, `Kills (${r.kills.length})`, 12, true);
  y += 16;
  if (r.kills.length) {
    table(
      ['Time', 'Victim', 'Killed by', 'Weapon'],
      [60, 160, 150, 125],
      r.kills.map((k) => [fmt(k.time), `${k.victim} (${FORCE_NAMES[k.victimForce]})`, k.killer ?? '-', k.weaponId ? weaponName(k.weaponId) : '-']),
    );
  } else {
    pdf.text(left, y, 'None.', 9);
    y += 20;
  }

  need(40);
  pdf.text(left, y, 'Rounds fired by weapon', 12, true);
  y += 16;
  table(
    ['Weapon', 'Rounds'],
    [300, 100],
    Object.entries(r.shotsByWeapon)
      .sort((a, b) => b[1] - a[1])
      .map(([w, n]) => [weaponName(w), String(n)]),
  );

  if (r.bookmarks.length) {
    need(40);
    pdf.text(left, y, 'Bookmarks', 12, true);
    y += 16;
    table(['Time', 'Note'], [60, 435], r.bookmarks.map((b) => [fmt(b.time), b.text]));
  }
  return pdf.toBytes();
}
