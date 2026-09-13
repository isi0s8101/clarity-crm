import { PublicBooking } from "../../public-v12";

export const dynamic = "force-dynamic";

export default async function PublicBookingPage({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  return <PublicBooking publicId={publicId} />;
}
