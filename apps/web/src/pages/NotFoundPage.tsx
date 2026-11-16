import { ButtonLink } from "../ui/Button";
import { EmptyState } from "../ui/misc";

export const NotFoundPage = () => (
    <div className="mx-auto max-w-lg py-10">
        <EmptyState
            title="Page not found"
            action={<ButtonLink to="/">Go to your problems</ButtonLink>}
        >
            The page does not exist or you do not have access to it.
        </EmptyState>
    </div>
);
