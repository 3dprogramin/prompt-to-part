// Polymaker's own hex codes and transmission distances (wiki.polymaker.com, 'Hex codes and transmission distances'), read on 2026-11-17.
// Left out: the PolyTerra PLA and PolyTerra PLA+ lines, which repeat the Panchroma values under the old product name.
// Also left out: Panchroma PLA Cold White, a near-white with TD 0.3 where the same hex under another line has TD 1.5 (likely an error in the sheet).
// The trailing comment on each entry is the maker's product code.
import type { LibraryFilament } from '../filaments';

const SOURCE = 'https://wiki.polymaker.com/polymaker-products/more-about-our-products/hex-codes-and-transmission-distances';

export const POLYMAKER_FILAMENTS: LibraryFilament[] = [
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Arctic Teal', color: '#61bcc3', td: 0.6, source: SOURCE }, // SKU CA04006
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Army Beige', color: '#dbbaa5', td: 0.7, source: SOURCE }, // SKU CA04007
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Army Blue', color: '#2e4462', td: 0.1, source: SOURCE }, // SKU CA04008
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Army Brown', color: '#795a4d', td: 0.1, source: SOURCE }, // SKU CA04009, PC1002003
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Army Dark Green', color: '#5f6244', td: 0.1, source: SOURCE }, // SKU CA04010
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Army Light Green', color: '#ab8c02', td: 0.8, source: SOURCE }, // SKU CA04011, PC1002004
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Army Purple', color: '#36364a', td: 0.2, source: SOURCE }, // SKU CA04012, PC1002005
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Army Red', color: '#bf312e', td: 0.3, source: SOURCE }, // SKU CA04013
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Ash Grey', color: '#485155', td: 0.1, source: SOURCE }, // SKU CA04014, PC1002006
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Charcoal Black', color: '#2f2e30', td: 0.1, source: SOURCE }, // SKU CA04015
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Cotton White', color: '#f4efeb', td: 4.1, source: SOURCE }, // SKU CA04016
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Earth Brown', color: '#7c594a', td: 0.2, source: SOURCE }, // SKU CA04017
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Electric Indigo', color: '#6858a9', td: 0.3, source: SOURCE }, // SKU CA04018, PC1002007
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Electric Magenta', color: '#d33a6d', td: 2.5, source: SOURCE }, // SKU PC1002022
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Emerald Green', color: '#22624f', td: 0.1, source: SOURCE }, // SKU PC1002027
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Forest Green', color: '#60ad70', td: 0.3, source: SOURCE }, // SKU CA04019
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Fossil Grey', color: '#8a8c94', td: 0.4, source: SOURCE }, // SKU CA04020
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Grass Green', color: '#32bc46', td: 0.6, source: SOURCE }, // SKU PC1002023
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Lava Red', color: '#ed2f2e', td: 1.9, source: SOURCE }, // SKU CA04021
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Lavender Purple', color: '#9572bf', td: 0.6, source: SOURCE }, // SKU CA04022
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Lime Green', color: '#d7d602', td: 2.4, source: SOURCE }, // SKU CA04023, PC1002008
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Lotus Pink', color: '#dd76c0', td: 2, source: SOURCE }, // SKU CA04002, PC1002002
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Muted Blue', color: '#5f778e', td: 0.5, source: SOURCE }, // SKU CA04024, PC1002009
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Muted Green', color: '#777e71', td: 0.5, source: SOURCE }, // SKU CA04025
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Muted Mauve', color: '#a36d82', td: 0.9, source: SOURCE }, // SKU PC1002030
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Muted Moss', color: '#92864f', td: 0.3, source: SOURCE }, // SKU PC1002028
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Muted Purple', color: '#7c5c78', td: 0.6, source: SOURCE }, // SKU CA04026, PC1002011
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Muted Red', color: '#d84b2e', td: 1.4, source: SOURCE }, // SKU CA04027, PC1002012
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Muted Teal', color: '#5d989e', td: 0.4, source: SOURCE }, // SKU PC1002029
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Muted Terracotta', color: '#c06443', td: 0.8, source: SOURCE }, // SKU PC1002031
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Muted White', color: '#bbada4', td: 0.7, source: SOURCE }, // SKU CA04028, PC1002013
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Pastel Banana', color: '#f7d475', td: 3.6, source: SOURCE }, // SKU CA04029, PC1002014
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Pastel Beige', color: '#e4d0b0', td: 1.6, source: SOURCE }, // SKU PC1002033
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Pastel Candy', color: '#f0d6d9', td: 2.9, source: SOURCE }, // SKU CA04030, PC1002015
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Pastel Coral', color: '#f09a7e', td: 2.3, source: SOURCE }, // SKU PC1002032
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Pastel Ice', color: '#a4d0df', td: 1.8, source: SOURCE }, // SKU CA04031, PC1002016
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Pastel Mint', color: '#d2debb', td: 2.9, source: SOURCE }, // SKU CA04032, PC1002017
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Pastel Peach', color: '#f6bf8b', td: 3.3, source: SOURCE }, // SKU CA04033, PC1002018
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Pastel Peanut', color: '#bf9573', td: 0.7, source: SOURCE }, // SKU CA04034
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Pastel Periwinkle', color: '#adb4e6', td: 1.5, source: SOURCE }, // SKU CA04036, PC1002020
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Pastel Watermelon', color: '#ee474b', td: 2.4, source: SOURCE }, // SKU CA04035, PC1002019
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Raspberry Blue', color: '#5472d0', td: 0.5, source: SOURCE }, // SKU PC1002025
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Sakura Pink', color: '#eaadbd', td: 2.3, source: SOURCE }, // SKU CA04037
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Sapphire Blue', color: '#0163a6', td: 0.5, source: SOURCE }, // SKU CA04038
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Savannah Yellow', color: '#f3c432', td: 3.5, source: SOURCE }, // SKU CA04039
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Seafoam Green', color: '#7dd4be', td: 1.1, source: SOURCE }, // SKU PC1002024
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Sky Blue', color: '#1ac5fc', td: 1.3, source: SOURCE }, // SKU CA04001, PC1002001
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Sunrise Orange', color: '#f88b17', td: 2.9, source: SOURCE }, // SKU CA04040
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Sunshine Yellow', color: '#f9da07', td: 2.3, source: SOURCE }, // SKU PC1002021
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Wine Burgundy', color: '#753e4c', td: 0.1, source: SOURCE }, // SKU PC1002026
  { brand: 'Polymaker', line: 'Panchroma Matte', name: 'Panchroma Matte Wood Brown', color: '#ab7449', td: 0.2, source: SOURCE }, // SKU CA04041
  { brand: 'Polymaker', line: 'Panchroma Neon', name: 'Panchroma Neon Green', color: '#00f263', td: 4.9, source: SOURCE }, // SKU CA02006
  { brand: 'Polymaker', line: 'Panchroma Neon', name: 'Panchroma Neon Magenta', color: '#f21185', td: 3.1, source: SOURCE }, // SKU CA02009
  { brand: 'Polymaker', line: 'Panchroma Neon', name: 'Panchroma Neon Orange', color: '#ff7800', td: 7, source: SOURCE }, // SKU CA02008
  { brand: 'Polymaker', line: 'Panchroma Neon', name: 'Panchroma Neon Pink', color: '#ff3670', td: 3.8, source: SOURCE }, // SKU CA02005
  { brand: 'Polymaker', line: 'Panchroma Neon', name: 'Panchroma Neon Red', color: '#fe2d42', td: 3.5, source: SOURCE }, // SKU CA02010
  { brand: 'Polymaker', line: 'Panchroma Neon', name: 'Panchroma Neon Yellow', color: '#e5db2e', td: 7.6, source: SOURCE }, // SKU CA02007
  { brand: 'Polymaker', line: 'Panchroma PLA', name: 'Panchroma PLA Aqua Blue', color: '#5ebddb', td: 1.5, source: SOURCE }, // SKU CA19016, PC1001028
  { brand: 'Polymaker', line: 'Panchroma PLA', name: 'Panchroma PLA Azure Blue', color: '#0066d9', td: 1.5, source: SOURCE }, // SKU CA19024, PC1001034
  { brand: 'Polymaker', line: 'Panchroma PLA', name: 'Panchroma PLA Beige', color: '#c2ab72', td: 0.5, source: SOURCE }, // SKU CA19015, PC1001027
  { brand: 'Polymaker', line: 'Panchroma PLA', name: 'Panchroma PLA Black', color: '#080a0d', td: 0.1, source: SOURCE }, // SKU CA19006
  { brand: 'Polymaker', line: 'Panchroma PLA', name: 'Panchroma PLA Blue', color: '#003776', td: 0.3, source: SOURCE }, // SKU CA19005
  { brand: 'Polymaker', line: 'Panchroma PLA', name: 'Panchroma PLA Brown', color: '#55331a', td: 0.1, source: SOURCE }, // SKU CA19018
  { brand: 'Polymaker', line: 'Panchroma PLA', name: 'Panchroma PLA Cream', color: '#eed1a8', td: 1.5, source: SOURCE }, // SKU CA19021, PC1001031
  { brand: 'Polymaker', line: 'Panchroma PLA', name: 'Panchroma PLA Dark Grey', color: '#485259', td: 0.2, source: SOURCE }, // SKU CA19028, PC1001037
  { brand: 'Polymaker', line: 'Panchroma PLA', name: 'Panchroma PLA Dark Olive Drab', color: '#575b54', td: 0.1, source: SOURCE }, // SKU CA19026, PC1001036
  { brand: 'Polymaker', line: 'Panchroma PLA', name: 'Panchroma PLA Green', color: '#06924d', td: 0.4, source: SOURCE }, // SKU CA19007
  { brand: 'Polymaker', line: 'Panchroma PLA', name: 'Panchroma PLA Grey', color: '#8c9099', td: 0.4, source: SOURCE }, // SKU CA19002
  { brand: 'Polymaker', line: 'Panchroma PLA', name: 'Panchroma PLA Jungle Green', color: '#4e742d', td: 0.1, source: SOURCE }, // SKU CA19013, PC1001025
  { brand: 'Polymaker', line: 'Panchroma PLA', name: 'Panchroma PLA Lemon Yellow', color: '#eed230', td: 3.3, source: SOURCE }, // SKU CA19019, PC1001030
  { brand: 'Polymaker', line: 'Panchroma PLA', name: 'Panchroma PLA Lime Green', color: '#d5d701', td: 2.3, source: SOURCE }, // SKU CA19022, PC1001032
  { brand: 'Polymaker', line: 'Panchroma PLA', name: 'Panchroma PLA Magenta', color: '#f24574', td: 1.4, source: SOURCE }, // SKU CA19023, PC1001033
  { brand: 'Polymaker', line: 'Panchroma PLA', name: 'Panchroma PLA Olive Green', color: '#948902', td: 0.1, source: SOURCE }, // SKU CA19014, PC1001026
  { brand: 'Polymaker', line: 'Panchroma PLA', name: 'Panchroma PLA Orange', color: '#f67405', td: 3.3, source: SOURCE }, // SKU CA19008
  { brand: 'Polymaker', line: 'Panchroma PLA', name: 'Panchroma PLA Pink', color: '#f1a1af', td: 1.8, source: SOURCE }, // SKU CA19009, PC1001022
  { brand: 'Polymaker', line: 'Panchroma PLA', name: 'Panchroma PLA Polymaker Teal', color: '#4cc0c7', td: 0.6, source: SOURCE }, // SKU CA19020
  { brand: 'Polymaker', line: 'Panchroma PLA', name: 'Panchroma PLA Purple', color: '#6c47b2', td: 0.1, source: SOURCE }, // SKU CA19010, PC1001023
  { brand: 'Polymaker', line: 'Panchroma PLA', name: 'Panchroma PLA Red', color: '#e72f1d', td: 1.9, source: SOURCE }, // SKU CA19004
  { brand: 'Polymaker', line: 'Panchroma PLA', name: 'Panchroma PLA Steel Grey', color: '#616469', td: 0.4, source: SOURCE }, // SKU CA19003
  { brand: 'Polymaker', line: 'Panchroma PLA', name: 'Panchroma PLA Stone Blue', color: '#487ba2', td: 0.3, source: SOURCE }, // SKU CA19017, PC1001029
  { brand: 'Polymaker', line: 'Panchroma PLA', name: 'Panchroma PLA Tan', color: '#a79e82', td: 0.7, source: SOURCE }, // SKU CA19025, PC1001035
  { brand: 'Polymaker', line: 'Panchroma PLA', name: 'Panchroma PLA White', color: '#ebf7ff', td: 3.2, source: SOURCE }, // SKU CA19001
  { brand: 'Polymaker', line: 'Panchroma PLA', name: 'Panchroma PLA Wine Red', color: '#d60212', td: 1, source: SOURCE }, // SKU CA19012, PC1001024
  { brand: 'Polymaker', line: 'Panchroma PLA', name: 'Panchroma PLA Yellow', color: '#ffe800', td: 4.3, source: SOURCE }, // SKU CA19011
  { brand: 'Polymaker', line: 'Panchroma Satin', name: 'Panchroma Satin Black', color: '#302e30', td: 0.1, source: SOURCE }, // SKU CA05011
  { brand: 'Polymaker', line: 'Panchroma Satin', name: 'Panchroma Satin Blue', color: '#0162a6', td: 0.3, source: SOURCE }, // SKU CA05002
  { brand: 'Polymaker', line: 'Panchroma Satin', name: 'Panchroma Satin Green', color: '#5eab71', td: 0.5, source: SOURCE }, // SKU CA05003
  { brand: 'Polymaker', line: 'Panchroma Satin', name: 'Panchroma Satin Grey', color: '#797e89', td: 0.1, source: SOURCE }, // SKU CA05004
  { brand: 'Polymaker', line: 'Panchroma Satin', name: 'Panchroma Satin Orange', color: '#fe9217', td: 3.3, source: SOURCE }, // SKU CA05005
  { brand: 'Polymaker', line: 'Panchroma Satin', name: 'Panchroma Satin Polymaker Teal', color: '#61bbc1', td: 0.2, source: SOURCE }, // SKU CA05006
  { brand: 'Polymaker', line: 'Panchroma Satin', name: 'Panchroma Satin Purple', color: '#9272c1', td: 0.9, source: SOURCE }, // SKU CA05007
  { brand: 'Polymaker', line: 'Panchroma Satin', name: 'Panchroma Satin Red', color: '#da1521', td: 2.2, source: SOURCE }, // SKU CA05008
  { brand: 'Polymaker', line: 'Panchroma Satin', name: 'Panchroma Satin White', color: '#f5f0ec', td: 3.8, source: SOURCE }, // SKU CA05009
  { brand: 'Polymaker', line: 'Panchroma Satin', name: 'Panchroma Satin Yellow', color: '#f4c131', td: 3.9, source: SOURCE }, // SKU CA05010
  { brand: 'Polymaker', line: 'Panchroma Silk', name: 'Panchroma Silk Black', color: '#363538', td: 0.1, source: SOURCE }, // SKU CA03001, PC1001001
  { brand: 'Polymaker', line: 'Panchroma Silk', name: 'Panchroma Silk Blue', color: '#4999c9', td: 1.3, source: SOURCE }, // SKU CA03002, PC1001002
  { brand: 'Polymaker', line: 'Panchroma Silk', name: 'Panchroma Silk Brass', color: '#968162', td: 0.8, source: SOURCE }, // SKU CA03003, PC1001003
  { brand: 'Polymaker', line: 'Panchroma Silk', name: 'Panchroma Silk Bronze', color: '#af6b4c', td: 0.7, source: SOURCE }, // SKU CA03004
  { brand: 'Polymaker', line: 'Panchroma Silk', name: 'Panchroma Silk Chrome', color: '#85898b', td: 0.3, source: SOURCE }, // SKU CA03005, PC1001004
  { brand: 'Polymaker', line: 'Panchroma Silk', name: 'Panchroma Silk Dark Blue', color: '#23599a', td: 0.6, source: SOURCE }, // SKU CA03031, PC1001005
  { brand: 'Polymaker', line: 'Panchroma Silk', name: 'Panchroma Silk Gold', color: '#c49449', td: 2.2, source: SOURCE }, // SKU CA03006
  { brand: 'Polymaker', line: 'Panchroma Silk', name: 'Panchroma Silk Green', color: '#55b687', td: 1, source: SOURCE }, // SKU CA03007, PC1001006
  { brand: 'Polymaker', line: 'Panchroma Silk', name: 'Panchroma Silk Gunmetal Grey', color: '#676b6a', td: 0.5, source: SOURCE }, // SKU CA03032, PC1001007
  { brand: 'Polymaker', line: 'Panchroma Silk', name: 'Panchroma Silk Light Blue', color: '#4cc1cb', td: 1.9, source: SOURCE }, // SKU CA03008, PC1001008
  { brand: 'Polymaker', line: 'Panchroma Silk', name: 'Panchroma Silk Lime', color: '#c4cf4c', td: 2.9, source: SOURCE }, // SKU CA03009, PC1001009
  { brand: 'Polymaker', line: 'Panchroma Silk', name: 'Panchroma Silk Magenta', color: '#aa538e', td: 2.1, source: SOURCE }, // SKU CA03010, PC1001010
  { brand: 'Polymaker', line: 'Panchroma Silk', name: 'Panchroma Silk Orange', color: '#eb6232', td: 3, source: SOURCE }, // SKU CA03011, PC1001011
  { brand: 'Polymaker', line: 'Panchroma Silk', name: 'Panchroma Silk Peridot Green', color: '#7f865b', td: 0.1, source: SOURCE }, // SKU CA03012, PC1001012
  { brand: 'Polymaker', line: 'Panchroma Silk', name: 'Panchroma Silk Periwinkle', color: '#768ec7', td: 1.3, source: SOURCE }, // SKU CA03033, PC1001013
  { brand: 'Polymaker', line: 'Panchroma Silk', name: 'Panchroma Silk Purple', color: '#786bb0', td: 1.2, source: SOURCE }, // SKU CA03014, PC1001015
  { brand: 'Polymaker', line: 'Panchroma Silk', name: 'Panchroma Silk Quartz Pink', color: '#dbbbbb', td: 3.5, source: SOURCE }, // SKU CA03013, PC1001014
  { brand: 'Polymaker', line: 'Panchroma Silk', name: 'Panchroma Silk Red', color: '#c1443f', td: 1.3, source: SOURCE }, // SKU CA03015, PC1001016
  { brand: 'Polymaker', line: 'Panchroma Silk', name: 'Panchroma Silk Rose', color: '#cf6076', td: 2.5, source: SOURCE }, // SKU CA03016, PC1001017
  { brand: 'Polymaker', line: 'Panchroma Silk', name: 'Panchroma Silk Rose Gold', color: '#cbb0b1', td: 2.2, source: SOURCE }, // SKU CA03017, PC1001018
  { brand: 'Polymaker', line: 'Panchroma Silk', name: 'Panchroma Silk Silver', color: '#bcc2c8', td: 2.4, source: SOURCE }, // SKU CA03018
  { brand: 'Polymaker', line: 'Panchroma Silk', name: 'Panchroma Silk Teal', color: '#66c2b6', td: 1.8, source: SOURCE }, // SKU CA03019, PC1001019
  { brand: 'Polymaker', line: 'Panchroma Silk', name: 'Panchroma Silk White', color: '#dfe4e4', td: 4.2, source: SOURCE }, // SKU CA03020, PC1001020
  { brand: 'Polymaker', line: 'Panchroma Silk', name: 'Panchroma Silk Yellow', color: '#eec810', td: 3.6, source: SOURCE }, // SKU CA03021, PC1001021
  { brand: 'Polymaker', line: 'Panchroma Translucent', name: 'Panchroma Translucent Cyan', color: '#08abfb', td: 8, source: SOURCE }, // SKU CA02001
  { brand: 'Polymaker', line: 'Panchroma Translucent', name: 'Panchroma Translucent Grey', color: '#9199a4', td: 11.5, source: SOURCE }, // SKU CA02004
  { brand: 'Polymaker', line: 'Panchroma Translucent', name: 'Panchroma Translucent Magenta', color: '#d93b90', td: 7.8, source: SOURCE }, // SKU CA02002
  { brand: 'Polymaker', line: 'Panchroma Translucent', name: 'Panchroma Translucent Yellow', color: '#f9ed3d', td: 14, source: SOURCE }, // SKU CA02003
];
