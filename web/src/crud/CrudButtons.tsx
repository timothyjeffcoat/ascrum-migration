// Port of directives/crud/crudButtons.js (AC-CRUD-07). Legacy hid Remove with ng-show; here it is
// not rendered. The spaces between the buttons reproduce the legacy template's inline whitespace.
import type { CrudForm } from './useCrudForm.ts'

type CrudButtonsProps = {
  form: Pick<CrudForm<object, object>, 'canSave' | 'canRevert' | 'canRemove' | 'save' | 'revert' | 'remove'>
}

export function CrudButtons({ form }: CrudButtonsProps) {
  return (
    <div>
      <button type="button" className="btn btn-primary save" disabled={!form.canSave} onClick={() => form.save()}>
        Save
      </button>{' '}
      <button type="button" className="btn btn-warning revert" onClick={() => form.revert()} disabled={!form.canRevert}>
        Revert changes
      </button>
      {form.canRemove && (
        <>
          {' '}
          <button type="button" className="btn btn-danger remove" onClick={() => form.remove()}>
            Remove
          </button>
        </>
      )}
    </div>
  )
}
