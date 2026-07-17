import { redirect } from "next/navigation";

/** Начало е премахнато — приложението стартира директно в Скенера. */
export default function HomePage() {
  redirect("/scanner");
}
