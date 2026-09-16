import type {
  BoardDefinition,
  EffectCard,
  PolicyCard,
  VoterCard,
} from '@seatgrab/content';
import {
  TRICK_CARDS,
  CONTENT_PACK_ID,
  CONTENT_PACK_VERSION,
  NEWS_CARDS,
  POLICY_CARDS,
  CORE_BOARD,
  RULESET_ID,
  RULESET_VERSION,
  VOTER_CARDS,
} from '@seatgrab/content';

export interface GameContent {
  contentPackId: string;
  contentVersion: string;
  rulesetId: string;
  rulesetVersion: string;
  board: BoardDefinition;
  voterCards: readonly VoterCard[];
  policyCards: readonly PolicyCard[];
  newsCards: readonly EffectCard[];
  trickCards: readonly EffectCard[];
}

export const CORE_CONTENT: GameContent = {
  contentPackId: CONTENT_PACK_ID,
  contentVersion: CONTENT_PACK_VERSION,
  rulesetId: RULESET_ID,
  rulesetVersion: RULESET_VERSION,
  board: CORE_BOARD,
  voterCards: VOTER_CARDS,
  policyCards: POLICY_CARDS,
  newsCards: NEWS_CARDS,
  trickCards: TRICK_CARDS,
};
