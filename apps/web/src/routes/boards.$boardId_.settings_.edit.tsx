import { createFileRoute } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Cause, Option, Schema } from "effect";
import { PencilRulerIcon } from "lucide-react";
import { BoardInstanceId } from "@repo/domain/Task";
import {
  definitionVocabularyAtom,
  editedBoardAtom,
  skillsAtom,
} from "@/lib/atoms/definition-edit-atom";
import { DefinitionEditor } from "@/components/definition-editor";
import { EmptyPane } from "@/components/empty-pane";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * `/boards/$boardId/settings/edit` (D6): edit the board's pinned definition version as a new version.
 * Its own page beside the settings (the `_` after `settings`), so the read-only page it is opened
 * from stays read-only, and a reload of the editor is a fresh read of the board and the lists.
 */
export const Route = createFileRoute("/boards/$boardId_/settings_/edit")({
  component: DefinitionEditRoute,
});

function DefinitionEditRoute() {
  const { boardId } = Route.useParams();
  const parsed = Schema.decodeUnknownOption(BoardInstanceId)(boardId);
  return (
    <EmptyPane
      icon={<PencilRulerIcon strokeWidth={1.75} />}
      title="Not a board id this control plane mints"
      detail="A board id is brd_ followed by Crockford base32. A link carrying anything else cannot resolve, so it is refused here instead of reaching the API."
      visible={Option.isNone(parsed)}
    >
      {Option.isSome(parsed) ? <DefinitionEdit boardId={parsed.value} /> : null}
    </EmptyPane>
  );
}

/**
 * Waits for the board's pinned version, the skill library and the vocabulary before opening the
 * editor: the pickers offer only what those say, so an editor without them could offer nothing a
 * person could pick. A failure of any is the page's, in the server's words.
 */
const DefinitionEdit = ({ boardId }: { readonly boardId: BoardInstanceId }) => {
  const board = useAtomValue(editedBoardAtom(boardId));
  const skills = useAtomValue(skillsAtom);
  const vocabulary = useAtomValue(definitionVocabularyAtom);

  // The board's own refusal first: a missing board says so rather than the lists' errors.
  const boardMissing =
    AsyncResult.isFailure(board) &&
    Option.exists(
      Cause.findErrorOption(board.cause),
      (error) => error._tag === "BoardNotFound",
    );
  const failure = AsyncResult.isFailure(board)
    ? Cause.pretty(board.cause)
    : AsyncResult.isFailure(skills)
      ? Cause.pretty(skills.cause)
      : AsyncResult.isFailure(vocabulary)
        ? Cause.pretty(vocabulary.cause)
        : undefined;
  if (failure !== undefined) {
    return (
      <EmptyPane
        icon={<PencilRulerIcon strokeWidth={1.75} />}
        title={boardMissing ? "No such board" : "The editor did not load"}
        detail={
          boardMissing
            ? `This control plane holds no board ${boardId}. It may have been made against another database.`
            : failure
        }
        visible
      />
    );
  }
  if (
    !AsyncResult.isSuccess(board) ||
    !AsyncResult.isSuccess(skills) ||
    !AsyncResult.isSuccess(vocabulary)
  ) {
    return (
      <div role="status" className="flex flex-1 flex-col gap-3 p-6">
        <span className="sr-only">Loading the board&apos;s definition</span>
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-24 w-full max-w-3xl" aria-hidden />
        ))}
      </div>
    );
  }
  return (
    <DefinitionEditor
      // A different pin is a different draft: never carry one board's edits onto another's version.
      key={`${board.value.instance.id}:${board.value.definition.version}`}
      instance={board.value.instance}
      pinned={board.value.definition}
      skills={skills.value.map((skill) => skill.name)}
      vocabulary={vocabulary.value}
    />
  );
};
