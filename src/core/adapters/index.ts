import { BaseTargetAdapter } from './base'
import { CodexDesktopAdapter } from './desktop/codex'
import { WorkBuddyAdapter } from './desktop/workbuddy'
import { AntigravityAdapter } from './desktop/antigravity'
import { OpenCodeAdapter } from './cli/opencode'
import { TargetCategory, TargetId } from '../types'

export class AdapterRegistry {
  private adapters: Map<TargetId, BaseTargetAdapter> = new Map()

  constructor() {
    this.register(new CodexDesktopAdapter())
    this.register(new WorkBuddyAdapter())
    this.register(new AntigravityAdapter())
    this.register(new OpenCodeAdapter())
  }

  private register(adapter: BaseTargetAdapter): void {
    this.adapters.set(adapter.id, adapter)
  }

  getAll(): BaseTargetAdapter[] {
    return Array.from(this.adapters.values())
  }

  getByCategory(category: TargetCategory): BaseTargetAdapter[] {
    return this.getAll().filter((a) => a.category === category)
  }

  getById(id: TargetId): BaseTargetAdapter | undefined {
    return this.adapters.get(id)
  }
}

export const registry = new AdapterRegistry()
