// The viewer's colours (highlight, neutral, line art joins) and the directions of its standard views.
import * as THREE from 'three';
import type { ViewName } from './types';

export const SELECTED_GLOW = new THREE.Color('#e0a43c').multiplyScalar(0.35);

export const NEUTRAL = new THREE.Color('#b9bcc2');
/** Line art's joins of loose ends (apart from the seams' blue), and the loose ends left (a warning). */
export const JOIN_COLOR = 0xff4fd8;
export const LOOSE_COLOR = 0xffb020;

export const VIEW_DIRS: Record<ViewName, [number, number, number]> = {
  iso: [1, -1.15, 0.85],
  front: [0, -1, 0],
  back: [0, 1, 0],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, -1e-4, 1],
  bottom: [0, -1e-4, -1],
};
