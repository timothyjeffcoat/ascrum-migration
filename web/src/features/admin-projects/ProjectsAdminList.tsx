// Port of ProjectsListCtrl + admin/projects/projects-list.tpl.html (AC-APR-01).
import type { Project } from '../../api/types.ts'
import { useListNav } from '../../crud/useListNav.ts'

type ProjectsAdminListProps = { projects: readonly Project[] }

export function ProjectsAdminList({ projects }: ProjectsAdminListProps) {
  const { onNew, onEdit } = useListNav('/admin/projects')
  return (
    <>
      <table className="table table-bordered table-condensed table-striped table-hover">
        <thead>
          <tr>
            <th>Name</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((project) => (
            <tr key={project.id} onClick={() => project.id !== undefined && onEdit(project.id)}>
              <td>{project.name}</td>
              <td>{project.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="well">
        <button type="button" className="btn" onClick={onNew}>
          New Project
        </button>
      </div>
    </>
  )
}
