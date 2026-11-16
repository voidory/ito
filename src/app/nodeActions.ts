import type { PageId, RelationshipId } from "../model";
import type { Workbench } from "./workbench";

/**
 * Shared command handlers for graph actions. UI surfaces (selected-node actions,
 * context menu, double-click, keyboard) call these functions directly rather
 * than finding or clicking another control in the DOM.
 */
export function openNodePageAction(
  wb: Workbench,
  pageId: string,
  bump: () => void,
): void {
  wb.openNodeWorkspace(pageId as PageId);
  wb.setViewMode("files");
  bump();
}

export function openRelationshipPageAction(
  wb: Workbench,
  relationshipId: string,
  bump: () => void,
): void {
  void wb.developRelationshipPage(relationshipId as RelationshipId).then(bump);
}

export function openRelationshipWorkspaceAction(
  wb: Workbench,
  relationshipId: string,
  bump: () => void,
): void {
  void wb.openRelationshipWorkspace(relationshipId as RelationshipId).then(() => {
    wb.setViewMode("files");
    bump();
  });
}
