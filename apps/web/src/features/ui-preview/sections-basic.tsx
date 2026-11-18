import {
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  AlertTitle,
  Badge,
  type BadgeColor,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Checkbox,
  DataTable,
  type DataTableColumn,
  DetailList,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
  ScrollArea,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  Separator,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  Switch,
  Textarea,
  Tooltip,
  useAppForm,
} from '@product-res/ui'
import { ArrowRight, Plus } from '@product-res/ui/icons'
import { useState } from 'react'
import { z } from 'zod'
import { m } from '../../paraglide/messages.js'
import { dataTableLabels } from '../i18n/table-labels.ts'
import { ThemeToggle } from '../theme/theme-toggle.tsx'
import { PreviewSection, Specimen } from './layout.tsx'
import { SAMPLE_PEOPLE, SAMPLE_PROJECTS, type SampleProject } from './sample-data.ts'

const BUTTON_VARIANTS = ['default', 'secondary', 'outline', 'ghost', 'destructive', 'link'] as const
const BADGE_COLORS: readonly BadgeColor[] = [
  'accent',
  'gray',
  'red',
  'amber',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
]

export function ButtonSection() {
  return (
    <PreviewSection id="button" title="Button" description={m.ui_preview_button_desc()}>
      <Specimen label={m.ui_preview_variants()} wide>
        {BUTTON_VARIANTS.map((variant) => (
          <Button key={variant} variant={variant}>
            {variant}
          </Button>
        ))}
      </Specimen>
      <Specimen label={m.ui_preview_sizes()}>
        <Button size="lg">lg</Button>
        <Button>default</Button>
        <Button size="sm">sm</Button>
        <Button size="compact">compact</Button>
        <Button size="icon" aria-label={m.ui_preview_add()}>
          <Plus />
        </Button>
      </Specimen>
      <Specimen label={m.ui_preview_states()}>
        <Button leadingIcon={Plus}>{m.ui_preview_add()}</Button>
        <Button variant="outline" trailingIcon={ArrowRight}>
          {m.ui_preview_continue()}
        </Button>
        <Button loading>{m.ui_preview_saving()}</Button>
        <Button disabled>{m.ui_preview_disabled()}</Button>
      </Specimen>
    </PreviewSection>
  )
}

export function FieldsSection() {
  return (
    <PreviewSection id="fields" title="Input · Textarea" description={m.ui_preview_fields_desc()}>
      <Specimen label={m.ui_preview_states()} className="flex-col items-stretch">
        <Input aria-label={m.ui_preview_project_name()} placeholder={m.ui_preview_project_name()} />
        <Input aria-label={m.ui_preview_owner()} defaultValue="Ada Lovelace" />
        <Input aria-label={m.ui_preview_invalid()} aria-invalid defaultValue="@@" />
        <Input
          aria-label={m.ui_preview_disabled()}
          disabled
          placeholder={m.ui_preview_disabled()}
        />
      </Specimen>
      <Specimen label="Textarea · compact" className="flex-col items-stretch">
        <Textarea aria-label={m.ui_preview_notes()} placeholder={m.ui_preview_notes()} />
        <Input size="compact" aria-label="compact" placeholder="compact" />
      </Specimen>
    </PreviewSection>
  )
}

export function SelectSection() {
  return (
    <PreviewSection id="select" title="Select" description={m.ui_preview_select_desc()}>
      <Specimen label={m.ui_preview_default()}>
        <Select defaultValue="active">
          <SelectTrigger
            className="w-56"
            aria-label={m.ui_preview_status()}
            placeholder={m.ui_preview_choose()}
          />
          <SelectContent>
            <SelectItem index={0} value="active">
              {m.ui_preview_status_active()}
            </SelectItem>
            <SelectItem index={1} value="paused">
              {m.ui_preview_status_paused()}
            </SelectItem>
            <SelectItem index={2} value="archived">
              {m.ui_preview_status_archived()}
            </SelectItem>
          </SelectContent>
        </Select>
      </Specimen>
      <Specimen label={m.ui_preview_groups_error()}>
        <Select>
          <SelectTrigger
            className="w-56"
            aria-label={m.ui_preview_owner()}
            placeholder={m.ui_preview_choose()}
            error={m.ui_preview_required()}
          />
          <SelectContent>
            <SelectGroup>
              <SelectLabel>{m.ui_preview_group_a()}</SelectLabel>
              {SAMPLE_PEOPLE.slice(0, 3).map((name, index) => (
                <SelectItem key={name} index={index} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectGroup>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>{m.ui_preview_group_b()}</SelectLabel>
              {SAMPLE_PEOPLE.slice(3, 6).map((name, index) => (
                <SelectItem key={name} index={index + 3} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Specimen>
    </PreviewSection>
  )
}

export function ChoiceSection() {
  const [sync, setSync] = useState(true)
  const [digest, setDigest] = useState(false)
  return (
    <PreviewSection id="choice" title="Checkbox · Switch" description={m.ui_preview_choice_desc()}>
      <Specimen label="Checkbox">
        <Label className="font-normal">
          <Checkbox defaultChecked={false} /> {m.ui_preview_unchecked()}
        </Label>
        <Label className="font-normal">
          <Checkbox defaultChecked /> {m.ui_preview_checked()}
        </Label>
        <Label className="font-normal">
          <Checkbox indeterminate /> {m.ui_preview_indeterminate()}
        </Label>
        <Label className="font-normal">
          <Checkbox disabled /> {m.ui_preview_disabled()}
        </Label>
      </Specimen>
      <Specimen label="Switch" className="flex-col items-stretch">
        <Switch label={m.ui_preview_sync()} checked={sync} onToggle={() => setSync((v) => !v)} />
        <Switch
          label={m.ui_preview_digest()}
          checked={digest}
          onToggle={() => setDigest((v) => !v)}
        />
        <Switch label={m.ui_preview_disabled()} checked={false} onToggle={() => {}} disabled />
      </Specimen>
    </PreviewSection>
  )
}

export function BadgeTooltipSection() {
  return (
    <PreviewSection id="badge" title="Badge · Tooltip" description={m.ui_preview_badge_desc()}>
      <Specimen label="solid">
        {BADGE_COLORS.map((color) => (
          <Badge key={color} color={color}>
            {color}
          </Badge>
        ))}
      </Specimen>
      <Specimen label="dot · ghost · compact">
        <Badge variant="dot" color="green">
          {m.ui_preview_status_active()}
        </Badge>
        <Badge variant="dot" color="amber">
          {m.ui_preview_status_paused()}
        </Badge>
        <Badge variant="ghost" color="gray">
          {m.ui_preview_status_archived()}
        </Badge>
        <Badge size="compact" color="blue">
          compact
        </Badge>
      </Specimen>
      <Specimen label="Tooltip">
        {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
          <Tooltip key={side} content={m.ui_preview_tooltip_text()} side={side}>
            <Button variant="outline" size="sm">
              {side}
            </Button>
          </Tooltip>
        ))}
      </Specimen>
    </PreviewSection>
  )
}

export function DialogSection() {
  return (
    <PreviewSection
      id="dialog"
      title="Dialog · AlertDialog · Popover · Sheet"
      description={`${m.ui_preview_dialog_desc()} ${m.ui_preview_dialog_desc_overlays()}`}
    >
      <Specimen label="Dialog">
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline">{m.ui_preview_open_dialog()}</Button>
          </DialogTrigger>
          <DialogContent closeLabel={m.ui_preview_close()}>
            <DialogHeader>
              <DialogTitle>{m.ui_preview_rename_project()}</DialogTitle>
              <DialogDescription>{m.ui_preview_rename_desc()}</DialogDescription>
            </DialogHeader>
            <Input aria-label={m.ui_preview_project_name()} defaultValue="Atlas" />
            <DialogFooter>
              <Button>{m.ui_preview_save()}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Specimen>
      <Specimen label="Popover">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline">{m.ui_preview_open_popover()}</Button>
          </PopoverTrigger>
          <PopoverContent align="start" aria-labelledby="preview-popover-title">
            <PopoverHeader>
              <PopoverTitle id="preview-popover-title">{m.ui_preview_popover_title()}</PopoverTitle>
              <PopoverDescription>{m.ui_preview_popover_body()}</PopoverDescription>
            </PopoverHeader>
          </PopoverContent>
        </Popover>
      </Specimen>
      <Specimen label="Sheet · bottom">
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline">{m.ui_preview_open_sheet()}</Button>
          </SheetTrigger>
          <SheetContent side="bottom" closeLabel={m.ui_preview_close()}>
            <SheetHeader className="pb-8">
              <SheetTitle>{m.ui_preview_sheet_title()}</SheetTitle>
              <SheetDescription>{m.ui_preview_sheet_body()}</SheetDescription>
            </SheetHeader>
          </SheetContent>
        </Sheet>
      </Specimen>
      <Specimen label="AlertDialog">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive">{m.ui_preview_delete_project()}</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{m.ui_preview_delete_title()}</AlertDialogTitle>
              <AlertDialogDescription>{m.ui_preview_delete_desc()}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{m.ui_preview_cancel()}</AlertDialogCancel>
              <AlertDialogAction variant="destructive">{m.ui_preview_delete()}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Specimen>
    </PreviewSection>
  )
}

export function SurfaceSection() {
  return (
    <PreviewSection
      id="surface"
      title="Card · Alert · Separator · ScrollArea"
      description={m.ui_preview_surface_desc()}
    >
      <Specimen label="Card" className="block">
        <Card>
          <CardHeader>
            <CardTitle>Atlas</CardTitle>
            <CardDescription>{m.ui_preview_card_desc()}</CardDescription>
          </CardHeader>
          <CardContent>
            <DetailList
              fields={[
                { label: m.ui_preview_owner(), value: 'Ada Lovelace' },
                { label: m.ui_preview_status(), value: m.ui_preview_status_active() },
              ]}
            />
          </CardContent>
          <CardFooter className="gap-2">
            <Button size="sm">{m.ui_preview_continue()}</Button>
            <Button size="sm" variant="ghost">
              {m.ui_preview_cancel()}
            </Button>
          </CardFooter>
        </Card>
      </Specimen>
      <Specimen label="Alert" className="flex-col items-stretch">
        <Alert>
          <AlertTitle>{m.ui_preview_alert_title()}</AlertTitle>
          <AlertDescription>{m.ui_preview_alert_desc()}</AlertDescription>
        </Alert>
        <Alert variant="destructive">
          <AlertTitle>{m.ui_preview_alert_error_title()}</AlertTitle>
          <AlertDescription>{m.ui_preview_alert_error_desc()}</AlertDescription>
        </Alert>
      </Specimen>
      <Specimen label="Separator · ScrollArea" className="flex-col items-stretch">
        <ScrollArea className="h-40 rounded-lg border">
          <ul className="flex flex-col p-2 text-body">
            {[
              ...SAMPLE_PROJECTS,
              ...SAMPLE_PROJECTS.map((p) => ({ ...p, id: `${p.id}-copy` })),
            ].map((project) => (
              <li key={project.id} className="flex flex-col">
                <span className="px-2 py-1.5">{project.name}</span>
                <Separator />
              </li>
            ))}
          </ul>
        </ScrollArea>
      </Specimen>
      <Specimen label="ThemeToggle">
        <ThemeToggle />
      </Specimen>
    </PreviewSection>
  )
}

const PAGE_SIZE = 3

export function DataTableSection() {
  const [pageIndex, setPageIndex] = useState(0)
  const [filters, setFilters] = useState<Record<string, string>>({})
  const statusLabel = (status: SampleProject['status']) =>
    ({
      active: m.ui_preview_status_active(),
      paused: m.ui_preview_status_paused(),
      archived: m.ui_preview_status_archived(),
    })[status]
  const columns: readonly DataTableColumn<SampleProject>[] = [
    { id: 'name', header: m.ui_preview_project_name(), cell: (row) => row.name },
    { id: 'owner', header: m.ui_preview_owner(), cell: (row) => row.owner },
    {
      id: 'status',
      header: m.ui_preview_status(),
      cell: (row) => (
        <Badge
          variant="dot"
          color={row.status === 'active' ? 'green' : row.status === 'paused' ? 'amber' : 'gray'}
        >
          {statusLabel(row.status)}
        </Badge>
      ),
    },
    { id: 'updated', header: m.ui_preview_updated(), cell: (row) => row.updated },
  ]
  const query = (filters.q ?? '').toLowerCase()
  const matching = SAMPLE_PROJECTS.filter(
    (row) =>
      (!query || row.name.toLowerCase().includes(query)) &&
      (!filters.status || row.status === filters.status),
  )
  const labels = dataTableLabels()
  return (
    <PreviewSection id="data-table" title="DataTable" description={m.ui_preview_table_desc()}>
      <Specimen label={m.ui_preview_default()} wide className="block">
        <DataTable
          label={m.ui_preview_projects()}
          columns={columns}
          rows={matching.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE)}
          getRowId={(row) => row.id}
          page={{ pageIndex, pageSize: PAGE_SIZE, rowCount: matching.length }}
          onPageChange={setPageIndex}
          filters={[
            { id: 'q', label: m.ui_preview_search(), placeholder: m.ui_preview_project_name() },
            {
              id: 'status',
              label: m.ui_preview_status(),
              type: 'select',
              options: [
                { value: '', label: m.ui_preview_all() },
                { value: 'active', label: m.ui_preview_status_active() },
                { value: 'paused', label: m.ui_preview_status_paused() },
                { value: 'archived', label: m.ui_preview_status_archived() },
              ],
            },
          ]}
          filterValues={filters}
          onFiltersChange={(values) => {
            setFilters(values)
            setPageIndex(0)
          }}
          labels={labels}
        />
      </Specimen>
      <Specimen label={m.ui_preview_empty_state()} wide className="block">
        <DataTable
          label={m.ui_preview_projects()}
          columns={columns}
          rows={[]}
          getRowId={(row) => row.id}
          page={{ pageIndex: 0, pageSize: PAGE_SIZE, rowCount: 0 }}
          onPageChange={() => {}}
          labels={labels}
        />
      </Specimen>
    </PreviewSection>
  )
}

export function FormSection() {
  const schema = z.object({
    name: z.string().trim().min(2, m.ui_preview_name_too_short()),
    email: z.email(m.ui_preview_email_invalid()),
  })
  const [submitted, setSubmitted] = useState<string | null>(null)
  const form = useAppForm({
    defaultValues: { name: '', email: '' },
    validators: { onBlur: schema, onSubmit: schema },
    onSubmit: async ({ value }) => {
      await new Promise((resolve) => setTimeout(resolve, 600))
      setSubmitted(value.name)
    },
  })
  return (
    <PreviewSection id="form" title="Form" description={m.ui_preview_form_desc()}>
      <Specimen label={m.ui_preview_validation()} className="block">
        <form.AppForm>
          <form.Form>
            <form.AppField name="name">
              {(field) => (
                <field.TextField
                  label={m.ui_preview_project_name()}
                  description={m.ui_preview_name_hint()}
                />
              )}
            </form.AppField>
            <form.AppField name="email">
              {(field) => <field.TextField label={m.ui_preview_email()} type="email" />}
            </form.AppField>
            <div className="flex items-center gap-3">
              <form.SubmitButton pendingLabel={m.ui_preview_saving()}>
                {m.ui_preview_save()}
              </form.SubmitButton>
              {submitted ? (
                <span role="status" className="text-body text-muted-foreground">
                  {m.ui_preview_saved({ name: submitted })}
                </span>
              ) : null}
            </div>
          </form.Form>
        </form.AppForm>
      </Specimen>
    </PreviewSection>
  )
}
