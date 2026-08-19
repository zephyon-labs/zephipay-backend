import type {
  CreateGrowthEventInput,
  GrowthEvent,
} from "./growthTypes";

export type GrowthEventAppendResult = Readonly<{
  event: GrowthEvent;
  created: boolean;
}>;

export interface GrowthEventRepository {
  append(input: CreateGrowthEventInput): Promise<GrowthEventAppendResult>;

  listByActor(
    actorAccountId: string,
    limit: number,
  ): Promise<GrowthEvent[]>;
}
