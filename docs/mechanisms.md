# Taskbus state and dependency contract

## Durable state

Pages are virtual roots with globally unique P-/T-/CP- IDs. A default page receives historical top-level tasks without changing their IDs. The journal keeps its v1 envelope; historical events replay in compatibility mode, while newly emitted task creation requires an explicit pageId for top-level tasks. No delete, drop, cancel, or replacement action removes node history. Archived split checkpoints remain inspectable and cannot execute, satisfy prerequisites, or be new dependency targets.

Each node stores its own ignore switch, prerequisite edges (strict/soft), and direct dirty reasons. Certainty, effective ignore, aggregate dirty, completion, and blockers are derived. An ignored ancestor masks descendants without overwriting their independent switches or original completion bits. Restoring ignore sets the restored subtree dirty and retains completion evidence until refresh explicitly keeps or reopens it.

## Derived states

Checkpoint certainty is certain or ignored, independently of pending/done/archived. A task is ignored when explicitly/inherited ignored or all nonempty children are ignored, certain when all children are certain, otherwise uncertain. Empty leaves remain certain and unplanned, never done; an unplanned descendant blocks ancestor completion. Nonignored tasks become done when every descendant checkpoint is done or ignored and no nonignored empty leaf remains. Progress counts done plus ignored, with separate counts; ignored nodes never satisfy done prerequisites.

## Dependencies and invalidation

Strict prerequisites must be certain when assigned and remain certain; soft prerequisites must remain nonignored. Ignore operations are simulated atomically and rejected if any retained prerequisite violates its certainty invariant. Execution checks checkpoint, owning task, and all ancestors: strict prerequisite clean+certainly done, soft prerequisite clean+done (certain or uncertain). Dirty prerequisites may be assigned but immediately dirty the dependent. Archived prerequisites retained after split block refresh until explicitly removed/replaced.

Cycle validation combines task-to-child completion edges and explicit dependency edges, including effective inherited prerequisite requirements, to reject containment-mediated deadlocks. Dependencies may cross pages.

Ignore/restore, split, reopen, dependency changes, and adding work invalidate prior dependents, including dependents of aggregate ancestors. Dirty propagation reaches a fixed point through explicit dependents, affected descendants, and ancestor aggregation. Direct task invalidation records dirty on its existing descendants as well, so reviewing the task never confirms their results in bulk. Ignored descendants retain their reasons but do not contribute aggregate dirty until restored. Only direct/ancestor-direct dirty blocks a healthy descendant's execution; aggregate-only dirty prevents using a task as a prerequisite but does not block healthy siblings. Running work reserves its task ancestry and prerequisite evidence; mutations that would affect an active target's validity/evidence are rejected before persistence.

## Refresh and queries

Refresh is atomic per node, requires a review summary, and can replace the complete prerequisite set. It rejects archived/ignored/dirty prerequisites, allows clean pending prerequisites, and requires a done checkpoint to explicitly choose keep or reopen. Task completion stays derived. A kept result with a clean pending prerequisite still cannot unblock downstream work: admission recursively checks the prerequisites of the evidence being consumed. Aggregate dirty cannot be cleared by refreshing the ancestor: its dirty descendants must be handled. A material dependency/result change invalidates successors; unchanged acknowledgment clears only direct dirty. Changing a task's prerequisites during refresh leaves descendants dirty for independent review. An available query returns globally referenceable leaf-task/checkpoint pairs, plus detailed blockers for waiting/ignored/dirty/done/archived/unplanned or running work when requested, with optional page/task filters. Archived checkpoints are historical and appear in `list.archived` and history rather than the active available-work pairs.

## Views

Browsing page is independent of execution and creation. New top-level tasks explicitly specify pageId; descendants inherit it. Old pages/nodes remain. Page switching wraps with Alt+Shift+h/l in the resident tree and Shift+h/l in the full tree, preserving selection, folding, and search for each page. English labels show dirty and ignored identities using symbols and semantic colors in addition to color. User-authored task text and agent task tracking retain their language.
