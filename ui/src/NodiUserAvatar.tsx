import Avatar from "boring-avatars";
import type { NodiUser } from "./sharing-store";

const nodiAvatarPalette = ["#6D63D8", "#8E84E8", "#7CB7B1", "#B8DDD3", "#F1C58B"];

export const NODI_INITIAL_AVATAR_ICON = "__nodi_initial__";

type NodiUserAvatarProps = {
  user: Pick<NodiUser, "name" | "email" | "avatarColor" | "avatarIcon">;
  className?: string;
};

export function NodiUserAvatar({ user, className = "" }: NodiUserAvatarProps) {
  const customIcon = user.avatarIcon?.trim();
  const usesInitial = customIcon === NODI_INITIAL_AVATAR_ICON;
  const avatarSeed = `${user.name.trim() || "Nodi"}::${user.email.trim().toLocaleLowerCase() || "user"}`;
  const initialSource = user.name.trim() || user.email.trim() || "N";
  const initial = Array.from(initialSource)[0]?.toLocaleUpperCase() ?? "N";
  const avatarKind = usesInitial ? "is-initial" : customIcon ? "is-custom" : "is-generated";

  return (
    <span
      className={`share-user-avatar ${avatarKind} ${className}`.trim()}
      data-color={user.avatarColor}
      data-has-icon={Boolean(customIcon) && !usesInitial}
      aria-hidden="true"
    >
      {usesInitial ? initial : customIcon || (
        <Avatar
          size="100%"
          name={avatarSeed}
          variant="beam"
          colors={nodiAvatarPalette}
          title={false}
        />
      )}
    </span>
  );
}
