/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "lucide-react/dist/esm/icons/*.mjs" {
  import type { ForwardRefExoticComponent, RefAttributes, SVGProps } from "react";

  type IconProps = Omit<SVGProps<SVGSVGElement>, "ref"> & {
    absoluteStrokeWidth?: boolean;
    size?: number | string;
  };
  const Icon: ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>;
  export default Icon;
}
