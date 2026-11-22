// Port of ProjectsInfoListCtrl + projectsinfo/list.tpl.html (R1). D1 preserved (spec §6, §1 non-goal:
// unfinished features stay unfinished): legacy put the loaded projects on the scope, but its template is
// only this heading, so the component does not read the loader data either.
export function ProjectsInfo() {
  return <h3>Projects info</h3>
}
