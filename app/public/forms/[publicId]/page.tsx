import { PublicForm } from "../../public-v12";

export const dynamic = "force-dynamic";

export default async function PublicFormPage({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  return <PublicForm publicId={publicId} />;
}
