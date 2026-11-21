import type { Metadata } from "next";
import AdminConsole from "./AdminConsole";
import "./admin.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Internal Access · IntraCampus",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export default function AdminPage() {
  return <AdminConsole />;
}
