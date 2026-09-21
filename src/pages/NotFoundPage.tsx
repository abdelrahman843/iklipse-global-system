import { Link } from "react-router-dom";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";

export function NotFoundPage() {
  return (
    <div className="min-h-full grid place-items-center">
      <EmptyState
        title="Page not found"
        description="The page you're looking for doesn't exist or has been moved."
        action={
          <Link to="/">
            <Button variant="primary">Go home</Button>
          </Link>
        }
      />
    </div>
  );
}
