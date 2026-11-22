import React from "react";
import { Studio } from "./Studio.jsx";
export const StoryPage = () => <Studio story />;
export const StagePage = () => <Studio story={false} />;
export { CinemaPage, FilmPage } from "./cinema/Cinema.jsx";
