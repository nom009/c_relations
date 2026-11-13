// ============================================================================
// 接続エフェクト「魔術回路」: 接続線に走る放電（ジグザグの稲妻が明滅）＋起点→終点へ流れる光、
// 両端ノードには基板配線のような回路が走って発光する。ドラッグ中の接続線も放電させる。
// ============================================================================
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import {
  BaseEdge,
  getBezierPath,
  getSmoothStepPath,
  type ConnectionLineComponentProps,
  type EdgeProps,
} from '@xyflow/react';

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

type Pt = [number, number];

// 経路に沿って垂直方向へランダムに揺らした稲妻（端点は固定）。branch で短い枝分かれを足す。
function bolt(pts: Pt[], amp: number, branch: boolean): string {
  const n = pts.length - 1;
  const out: Pt[] = [];
  let d = '';
  for (let i = 0; i <= n; i++) {
    const [x, y] = pts[i];
    const [ax, ay] = pts[Math.max(0, i - 1)];
    const [bx, by] = pts[Math.min(n, i + 1)];
    const l = Math.hypot(bx - ax, by - ay) || 1;
    const o = (Math.random() * 2 - 1) * amp * Math.sin((Math.PI * i) / n);
    const p: Pt = [x - ((by - ay) / l) * o, y + ((bx - ax) / l) * o];
    out.push(p);
    d += (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1);
  }
  if (branch && n > 6) {
    for (let k = 0; k < 2; k++) {
      let [x, y] = out[1 + Math.floor(Math.random() * (n - 2))];
      const a = Math.random() * Math.PI * 2;
      d += `M${x.toFixed(1)} ${y.toFixed(1)}`;
      for (let s = 0; s < 3; s++) {
        x += Math.cos(a + (Math.random() - 0.5) * 1.4) * amp * 1.3;
        y += Math.sin(a + (Math.random() - 0.5) * 1.4) * amp * 1.3;
        d += `L${x.toFixed(1)} ${y.toFixed(1)}`;
      }
    }
  }
  return d;
}

// 描画済みの経路 <path> をサンプリングし、稲妻を一定間隔で作り直して明滅させる。
function useLightning(ref: RefObject<SVGPathElement | null>, d: string, count: number, amp: number) {
  const [arcs, setArcs] = useState<string[]>([]);
  useEffect(() => {
    const el = ref.current;
    const total = el?.getTotalLength() ?? 0;
    if (!el || !total) return;
    const n = Math.min(90, Math.max(6, Math.round(total / 9)));
    const pts: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      const p = el.getPointAtLength((total * i) / n);
      pts.push([p.x, p.y]);
    }
    const gen = () => setArcs(Array.from({ length: count }, (_, k) => bolt(pts, amp * (k ? 0.55 : 1), k === 0)));
    gen();
    if (reducedMotion()) return;
    const iv = setInterval(gen, 55);
    return () => clearInterval(iv);
  }, [ref, d, count, amp]);
  return arcs;
}

function Discharge({ d, count, amp, pulse }: { d: string; count: number; amp: number; pulse?: boolean }) {
  const ref = useRef<SVGPathElement>(null);
  const arcs = useLightning(ref, d, count, amp);
  return (
    <g className="circuit-fx">
      <path ref={ref} d={d} className="cfx-glow" />
      {arcs.map((a, i) => (
        <path key={i} d={a} className={i ? 'cfx-arc thin' : 'cfx-arc'} />
      ))}
      <path d={d} className="cfx-core" />
      {pulse ? <path d={d} className="cfx-pulse" pathLength={1} /> : null}
    </g>
  );
}

// 接続直後のエッジ（type: 'circuit'）。通常の smoothstep と同じ経路に放電を重ねる。
export const CircuitEdge = memo(function CircuitEdge(p: EdgeProps) {
  const [d, labelX, labelY] = getSmoothStepPath(p);
  return (
    <>
      <BaseEdge
        id={p.id}
        path={d}
        style={p.style}
        markerEnd={p.markerEnd}
        label={p.label}
        labelX={labelX}
        labelY={labelY}
        interactionWidth={p.interactionWidth}
      />
      <Discharge d={d} count={3} amp={7} pulse />
    </>
  );
});

// ドラッグ中の接続線。接続可能な相手に重なると放電が強まる。
export function CircuitConnectionLine({
  fromX,
  fromY,
  toX,
  toY,
  fromPosition,
  toPosition,
  connectionStatus,
}: ConnectionLineComponentProps) {
  const [d] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: fromPosition,
    targetX: toX,
    targetY: toY,
    targetPosition: toPosition,
  });
  const valid = connectionStatus === 'valid';
  return (
    <g className={'circuit-line' + (valid ? ' valid' : '')}>
      <Discharge d={d} count={valid ? 3 : 2} amp={valid ? 8 : 5} />
    </g>
  );
}

// ---- ノード上を走る回路（基板配線風: 水平→45°→水平、終端にパッド）---------------------------
const W = 186;
const H = 64;

function rng(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

type Trace = { d: string; pad: Pt; delay: number };

function traces(seed: string, dir: 'out' | 'in'): Trace[] {
  const r = rng(seed + dir);
  const sx = dir === 'out' ? -1 : 1; // 接続した側の辺から内側へ伸ばす
  const lanes = [7, 15, 24, 32, 40, 49, 57];
  return lanes.map((lane, i) => {
    let x = dir === 'out' ? W : 0;
    let y = H / 2;
    let d = `M${x} ${y}`;
    const to = (nx: number, ny: number) => {
      x = Math.min(W - 6, Math.max(6, nx));
      y = Math.min(H - 5, Math.max(5, ny));
      d += `L${x.toFixed(1)} ${y.toFixed(1)}`;
    };
    to(x + sx * (5 + r() * 12), y);
    to(x + sx * Math.abs(lane - y), lane);
    to(x + sx * (18 + r() * 70), y);
    if (r() < 0.65) {
      const ny = y + (r() < 0.5 ? -1 : 1) * (4 + r() * 6);
      to(x + sx * Math.abs(ny - y), ny);
      to(x + sx * (8 + r() * 40), y);
    }
    return { d, pad: [x, y], delay: i * 28 + r() * 40 };
  });
}

export const CircuitTrace = memo(function CircuitTrace({ seed, dir }: { seed: string; dir: 'out' | 'in' }) {
  const ts = useMemo(() => traces(seed, dir), [seed, dir]);
  return (
    <svg className={'circuit-trace ' + dir} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      <rect className="ct-shade" width={W} height={H} />
      {ts.map((t, i) => {
        const style = { '--d': t.delay + 'ms' } as CSSProperties;
        return (
          <g key={i} style={style}>
            <path d={t.d} pathLength={1} className="ct-line" />
            <circle cx={t.pad[0]} cy={t.pad[1]} r={1.8} className="ct-pad" />
          </g>
        );
      })}
    </svg>
  );
});

export const edgeTypes = { circuit: CircuitEdge };
