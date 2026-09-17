/**
 * The asset manifest.
 *
 * Every drawn asset the application ships is listed here once, with the text equivalent a
 * screen reader and a colour-blind player rely on. The resource glyphs are Lucide icons
 * (ISC licence, see LICENSES/), drawn on a coloured disc; the party emblems are original.
 *
 * Each `?url` import is resolved and fingerprinted by the bundler, so a manifest entry
 * whose file is missing or renamed fails the build instead of turning into a broken image
 * at run time.
 */
import type { ResourceType } from '@gerrymander/content';

import { PARTY_IDENTITIES, type PartyIdentity } from './parties';

import influenceUrl from './resources/influence.svg?url';
import cogUrl from './parties/cog.svg?url';
import compassUrl from './parties/compass.svg?url';
import cashUrl from './resources/cash.svg?url';
import genericUrl from './resources/generic.svg?url';
import kiteUrl from './parties/kite.svg?url';
import lanternUrl from './parties/lantern.svg?url';
import pressUrl from './resources/press.svg?url';
import sproutUrl from './parties/sprout.svg?url';
import faithUrl from './resources/faith.svg?url';

export interface AssetEntry {
  /** Stable manifest key, used by components instead of a file path. */
  id: string;
  /** Bundled URL of the optimized SVG. */
  url: string;
  /** Text equivalent; never let color or shape carry meaning on its own. */
  label: string;
  /** What the drawn mark is, for the asset review table. */
  description: string;
}

/** The printed price icon for one resource type, plus the `?` any-resource icon. */
export type CostIconId = ResourceType | 'generic';

export const RESOURCE_ASSETS: Record<CostIconId, AssetEntry> = {
  cash: {
    id: 'resource/cash',
    url: cashUrl,
    label: 'Cash',
    description: 'Banknote on a green disc.',
  },
  influence: {
    id: 'resource/influence',
    url: influenceUrl,
    label: 'Influence',
    description: 'Megaphone on an orange disc.',
  },
  press: {
    id: 'resource/press',
    url: pressUrl,
    label: 'Press',
    description: 'Newspaper on a blue disc.',
  },
  faith: {
    id: 'resource/faith',
    url: faithUrl,
    label: 'Faith',
    description: 'Handshake heart on a violet disc.',
  },
  generic: {
    id: 'resource/generic',
    url: genericUrl,
    label: 'Any one resource',
    description:
      'Question mark on a pale disc. The `?` is a wildcard payment, not a fifth resource type.',
  },
};

/** A party identity joined to the emblem this build bundles for it. */
export interface PartyAsset extends AssetEntry, PartyIdentity {}

/** The drawn emblem for each party identity, by `partyId`. */
const PARTY_EMBLEM_URLS: Readonly<Record<string, string>> = {
  kite: kiteUrl,
  cog: cogUrl,
  sprout: sproutUrl,
  lantern: lanternUrl,
  compass: compassUrl,
};

/**
 * Five party identities, one per seat at the largest supported table.
 *
 * The roster itself lives in `parties.ts` so the lobby can read it without the bundler.
 * An identity with no bundled emblem throws here rather than rendering a broken image.
 */
export const PARTY_ASSETS: readonly PartyAsset[] = PARTY_IDENTITIES.map((party) => {
  const url = PARTY_EMBLEM_URLS[party.partyId];
  if (url === undefined) {
    throw new Error(`No emblem is bundled for the ${party.partyId} party.`);
  }
  return {
    ...party,
    id: `party/${party.partyId}`,
    url,
    label: `${party.displayName} party`,
  };
});

export const PARTY_BY_ID: ReadonlyMap<string, PartyAsset> = new Map(
  PARTY_ASSETS.map((party) => [party.partyId, party]),
);

/** Every manifest entry, in the order the asset review table lists them. */
export const ALL_ASSETS: readonly AssetEntry[] = [
  ...Object.values(RESOURCE_ASSETS),
  ...PARTY_ASSETS,
];
