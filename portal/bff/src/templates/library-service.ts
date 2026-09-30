// Template library service (EPIC-039 §5–§8; T-0762).
// Read-only browsing over the T-0761 template repository: local items
// filterable by the §9 type registry, plus the soft-delete behind the
// table's destructive row action. Browsing performs no tenant writes (SPEC §8);
// clone and import land with their own tickets.
import {
  InvalidTemplateTypeError,
  TEMPLATE_TYPES,
  type TemplateLibraryItem,
  type TemplateRepository,
} from "@m365-assess/db";

export const TEMPLATE_LIBRARY_LOCAL_SOURCE = "local" as const;

export interface ListLibraryItemsOptions {
  /** A `TEMPLATE_TYPES` value; omitted lists every local item. */
  readonly type?: string;
}

export interface TemplateLibraryService {
  listLocalItems(options?: ListLibraryItemsOptions): Promise<TemplateLibraryItem[]>;
  getLocalItem(itemId: string): Promise<TemplateLibraryItem | undefined>;
  deleteLocalItem(itemId: string): Promise<boolean>;
}

export class TemplateLibraryRepositoryService implements TemplateLibraryService {
  constructor(private readonly repository: TemplateRepository) {}

  async listLocalItems(options: ListLibraryItemsOptions = {}): Promise<TemplateLibraryItem[]> {
    if (options.type !== undefined && !isTemplateType(options.type)) {
      throw new InvalidTemplateTypeError(options.type);
    }
    return this.repository.listTemplateLibraryItems({
      source: TEMPLATE_LIBRARY_LOCAL_SOURCE,
      ...(options.type === undefined ? {} : { type: options.type }),
    });
  }

  async getLocalItem(itemId: string): Promise<TemplateLibraryItem | undefined> {
    const item = await this.repository.getTemplateLibraryItem(itemId);
    return item?.source === TEMPLATE_LIBRARY_LOCAL_SOURCE ? item : undefined;
  }

  async deleteLocalItem(itemId: string): Promise<boolean> {
    if (!(await this.getLocalItem(itemId))) return false;
    return this.repository.softDeleteTemplateLibraryItem(itemId);
  }
}

function isTemplateType(type: string): boolean {
  return (TEMPLATE_TYPES as readonly string[]).includes(type);
}
