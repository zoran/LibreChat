/** One bounded presentation camera; no observation scheduling or persistent fleet state. */
import { useCallback, useRef, useState } from 'react';
import type { Bounds, Selection, Preset } from './topology';
export type Camera = { x: number; y: number; scale: number };
export function fitCamera(b: Bounds): Camera {
  const scale = Math.max(0.12, Math.min(2, Math.min(1500 / b.width, 800 / b.height)));
  return { x: 800 - (b.x + b.width / 2) * scale, y: 450 - (b.y + b.height / 2) * scale, scale };
}
export default function useStatusCamera() {
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1 });
  const [history, setHistory] = useState<
    { camera: Camera; selection: Selection; preset: Preset }[]
  >([]);
  const [selection, setSelection] = useState<Selection>(null);
  const [preset, setPreset] = useState<Preset>('overview');
  const context = useRef({ selection, preset });
  context.current = { selection, preset };
  const current = useRef(camera);
  current.current = camera;
  const focus = useCallback(
    (bounds: Bounds, remember = true, next?: { selection: Selection; preset: Preset }) => {
      if (remember)
        setHistory((h) => [...h.slice(-19), { camera: current.current, ...context.current }]);
      setCamera(fitCamera(bounds));
      if (next) {
        setSelection(next.selection);
        setPreset(next.preset);
      }
    },
    [],
  );
  const back = useCallback(
    () =>
      setHistory((h) => {
        if (h.length) {
          const previous = h[h.length - 1];
          setCamera(previous.camera);
          setSelection(previous.selection);
          setPreset(previous.preset);
        }
        return h.slice(0, -1);
      }),
    [],
  );
  const pan = useCallback(
    (dx: number, dy: number) =>
      setCamera((c) => ({
        ...c,
        x: Math.max(-20000, Math.min(20000, c.x + dx)),
        y: Math.max(-20000, Math.min(20000, c.y + dy)),
      })),
    [],
  );
  const zoom = useCallback(
    (factor: number, x = 800, y = 450) =>
      setCamera((c) => {
        const scale = Math.max(0.12, Math.min(4, c.scale * factor));
        return {
          x: x - ((x - c.x) * scale) / c.scale,
          y: y - ((y - c.y) * scale) / c.scale,
          scale,
        };
      }),
    [],
  );
  return {
    camera,
    selection,
    setSelection,
    preset,
    setPreset,
    focus,
    back,
    pan,
    zoom,
    canBack: history.length > 0,
  };
}
