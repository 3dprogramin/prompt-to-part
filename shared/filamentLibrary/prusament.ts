// Prusa Research's own transparency values and hex codes (help.prusa3d.com, the article on filament transparency values and hexcodes), read on 2026-11-17.
import type { LibraryFilament } from '../filaments';

const SOURCE = 'https://help.prusa3d.com/article/hueforge-filament-transparency-values-and-hexcodes_762314';

export const PRUSAMENT_FILAMENTS: LibraryFilament[] = [
  { brand: 'Prusament', line: 'PLA', name: 'PLA Army Green', color: '#5e6344', td: 0.4, source: SOURCE },
  { brand: 'Prusament', line: 'PLA', name: 'PLA Azure Blue', color: '#0682ac', td: 6.6, source: SOURCE },
  { brand: 'Prusament', line: 'PLA', name: "PLA Gentleman's Grey", color: '#354046', td: 0.3, source: SOURCE },
  { brand: 'Prusament', line: 'PLA', name: 'PLA Gravity Grey', color: '#9fa4a7', td: 0.7, source: SOURCE },
  { brand: 'Prusament', line: 'PLA', name: 'PLA Jet Black', color: '#24292a', td: 0.3, source: SOURCE },
  { brand: 'Prusament', line: 'PLA', name: 'PLA Lipstick Red', color: '#d03036', td: 3.3, source: SOURCE },
  { brand: 'Prusament', line: 'PLA', name: 'PLA Pineapple Yellow', color: '#efd006', td: 7.6, source: SOURCE },
  { brand: 'Prusament', line: 'PLA', name: 'PLA Pristine White', color: '#e6eaed', td: 5.1, source: SOURCE },
  { brand: 'Prusament', line: 'PLA', name: 'PLA Prusa Orange', color: '#fe6e31', td: 6.6, source: SOURCE },
  { brand: 'Prusament', line: 'PLA', name: 'PLA Simply Green', color: '#70a640', td: 3, source: SOURCE },
  { brand: 'Prusament', line: 'PLA', name: 'PLA Vanilla White', color: '#d9d4c4', td: 7.1, source: SOURCE },
  { brand: 'Prusament', line: 'PLA Blend', name: 'PLA Blend Lime Green', color: '#a7b852', td: 3.5, source: SOURCE },
  { brand: 'Prusament', line: 'PLA Blend', name: 'PLA Blend Ms. Pink', color: '#e34a93', td: 4.1, source: SOURCE },
  { brand: 'Prusament', line: 'PLA Blend', name: 'PLA Blend Royal Blue', color: '#04518e', td: 0.8, source: SOURCE },
];
