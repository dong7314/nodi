import Avatar from "boring-avatars";
import type { NodiUser } from "./sharing-store";

const nodiAvatarPalette = ["#6D63D8", "#8E84E8", "#7CB7B1", "#B8DDD3", "#F1C58B"];

type NodiUserAvatarProps = {
  user: Pick<NodiUser, "name" | "email" | "avatarColor" | "avatarIcon">;
  className?: string;
};

export function NodiUserAvatar({ user, className = "" }: NodiUserAvatarProps) {
  const customIcon = user.avatarIcon?.trim();
  const avatarSeed = `${user.name.trim() || "Nodi"}::${user.email.trim().toLocaleLowerCase() || "user"}`;

  return (
    <span
      className={`share-user-avatar ${customIcon ? "is-custom" : "is-generated"} ${className}`.trim()}
      data-color={user.avatarColor}
      data-has-icon={Boolean(customIcon)}
      aria-hidden="true"
    >
      {customIcon || (
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
