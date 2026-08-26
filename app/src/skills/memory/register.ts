import type { EmbeddingProvider } from "../../brain/embedding-provider";
import type { MemoryService } from "../../memory/memory-service";
import type { MemoryRepositoryPort } from "../../memory/types";
import type { SkillRegistry } from "../registry";
import { createConversationSearchSkill } from "../conversation-search/skill";
import { createMemoryForgetSkill } from "../memory-forget/skill";
import { createMemoryRememberSkill } from "../memory-remember/skill";
import { createMemorySearchSkill } from "../memory-search/skill";

export function registerMemorySkills(
  registry: SkillRegistry,
  repository: MemoryRepositoryPort,
  embeddingProvider: EmbeddingProvider,
  memoryService: MemoryService,
): void {
  registry.register(createMemorySearchSkill(repository, embeddingProvider));
  registry.register(createMemoryRememberSkill(memoryService));
  registry.register(createMemoryForgetSkill(repository));
  registry.register(createConversationSearchSkill(repository));
}
