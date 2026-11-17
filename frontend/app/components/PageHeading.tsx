import type { ReactNode } from "react";
import Icon, { type IconName } from "./Icon";

export default function PageHeading({ eyebrow, title, description, icon, children }: {
  eyebrow: string; title: string; description: string; icon: IconName; children?: ReactNode;
}) {
  return <div className="page-heading">
    <div className="page-heading-copy"><span className="page-heading-icon"><Icon name={icon} /></span>
      <div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="page-description">{description}</p></div>
    </div>
    {children}
  </div>;
}
