import {
  Button,
  Combobox,
  ComboboxChips,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  CommandMenu,
  CommandMenuDialog,
  CommandMenuEmpty,
  CommandMenuFooter,
  CommandMenuInput,
  type CommandMenuItemData,
  type CommandMenuLabels,
  CommandMenuList,
  DropdownContent,
  DropdownEmpty,
  DropdownLabel,
  DropdownMenu,
  DropdownSearch,
  DropdownSeparator,
  DropdownSub,
  DropdownSubContent,
  DropdownSubTrigger,
  DropdownTrigger,
  MenuItem,
  Tabs,
  TabsItem,
  TabsPanel,
  Toaster,
  toast,
} from '@product-res/ui'
import { Folder, House, Inbox, Settings } from '@product-res/ui/icons'
import { useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { PreviewSection, Specimen } from './layout.tsx'
import { SAMPLE_PEOPLE, SAMPLE_PROJECTS } from './sample-data.ts'

export { SidebarSection } from './section-sidebar.tsx'

const PEOPLE_ITEMS = SAMPLE_PEOPLE.map((name) => ({ value: name, label: name }))

function ComboboxRows() {
  return (
    <ComboboxContent>
      <ComboboxEmpty>{m.ui_preview_no_results()}</ComboboxEmpty>
      <ComboboxList>
        {(item) =>
          typeof item === 'string' ? null : (
            <ComboboxItem value={item.value}>{item.label}</ComboboxItem>
          )
        }
      </ComboboxList>
    </ComboboxContent>
  )
}

export function ComboboxSection() {
  const [members, setMembers] = useState<string[]>(['Ada Lovelace', 'Alan Turing'])
  return (
    <PreviewSection id="combobox" title="Combobox" description={m.ui_preview_combobox_desc()}>
      <Specimen label={m.ui_preview_single()} className="flex-col items-stretch">
        <Combobox items={PEOPLE_ITEMS}>
          <ComboboxInput
            aria-label={m.ui_preview_owner()}
            placeholder={m.ui_preview_search_people()}
            clearable
            clearLabel={m.ui_preview_clear()}
          />
          <ComboboxRows />
        </Combobox>
        <Combobox items={PEOPLE_ITEMS}>
          <ComboboxInput
            aria-label={m.ui_preview_invalid()}
            placeholder={m.ui_preview_search_people()}
            error={m.ui_preview_required()}
          />
          <ComboboxRows />
        </Combobox>
      </Specimen>
      <Specimen label={m.ui_preview_multiple()} className="flex-col items-stretch">
        <Combobox items={PEOPLE_ITEMS} multiple value={members} onValueChange={setMembers}>
          <ComboboxChips
            aria-label={m.ui_preview_members()}
            placeholder={m.ui_preview_search_people()}
            chipsLabel={m.ui_preview_members()}
            removeLabel={(label) => m.ui_preview_remove({ name: label })}
          />
          <ComboboxRows />
        </Combobox>
      </Specimen>
    </PreviewSection>
  )
}

export function TabsSection() {
  const [selected, setSelected] = useState(0)
  const [iconSelected, setIconSelected] = useState(0)
  const panels = [
    m.ui_preview_tab_overview(),
    m.ui_preview_tab_activity(),
    m.ui_preview_tab_settings(),
  ]
  return (
    <PreviewSection id="tabs" title="Tabs" description={m.ui_preview_tabs_desc()}>
      <Specimen label={m.ui_preview_default()} className="flex-col items-stretch">
        <Tabs
          aria-label={m.ui_preview_projects()}
          idPrefix="preview-tabs"
          selectedIndex={selected}
          onSelect={setSelected}
        >
          {panels.map((label, index) => (
            <TabsItem key={label} index={index} label={label} />
          ))}
        </Tabs>
        {panels.map((label, index) => (
          <TabsPanel key={label} index={index} selectedIndex={selected} idPrefix="preview-tabs">
            <p className="text-body text-muted-foreground">
              {m.ui_preview_tab_panel({ name: label })}
            </p>
          </TabsPanel>
        ))}
      </Specimen>
      <Specimen label={m.ui_preview_icons_active_label()}>
        <Tabs
          aria-label={m.ui_preview_projects()}
          idPrefix="preview-icon-tabs"
          selectedIndex={iconSelected}
          onSelect={setIconSelected}
          activeLabel
        >
          <TabsItem index={0} label={m.ui_preview_nav_home()} icon={House} />
          <TabsItem index={1} label={m.ui_preview_nav_projects()} icon={Folder} />
          <TabsItem index={2} label={m.ui_preview_nav_inbox()} icon={Inbox} />
          <TabsItem index={3} label={m.ui_preview_nav_settings()} icon={Settings} />
        </Tabs>
      </Specimen>
    </PreviewSection>
  )
}

const VIEW_COLUMNS = ['owner', 'status', 'updated'] as const

export function DropdownSection() {
  const [columns, setColumns] = useState<number[]>([0, 1])
  const [query, setQuery] = useState('')
  const columnLabels = [m.ui_preview_owner(), m.ui_preview_status(), m.ui_preview_updated()]
  const matches = SAMPLE_PROJECTS.filter((project) =>
    project.name.toLowerCase().includes(query.trim().toLowerCase()),
  )
  return (
    <PreviewSection id="dropdown" title="Dropdown" description={m.ui_preview_dropdown_desc()}>
      <Specimen label={m.ui_preview_actions_submenu()}>
        <DropdownMenu>
          <DropdownTrigger render={<Button variant="outline">{m.ui_preview_actions()}</Button>} />
          <DropdownContent>
            <DropdownLabel>Atlas</DropdownLabel>
            <MenuItem index={0} label={m.ui_preview_rename_project()} />
            <MenuItem index={1} label={m.ui_preview_duplicate()} />
            <DropdownSub>
              <DropdownSubTrigger index={2} label={m.ui_preview_move_to()} />
              <DropdownSubContent>
                <MenuItem index={0} label={m.ui_preview_nav_inbox()} />
                <MenuItem index={1} label={m.ui_preview_status_archived()} />
              </DropdownSubContent>
            </DropdownSub>
            <DropdownSeparator />
            <MenuItem index={3} label={m.ui_preview_delete()} disabled />
          </DropdownContent>
        </DropdownMenu>
      </Specimen>
      <Specimen label={m.ui_preview_checkable_search()}>
        <DropdownMenu>
          <DropdownTrigger render={<Button variant="outline">{m.ui_preview_columns()}</Button>} />
          <DropdownContent checkedIndices={columns}>
            {VIEW_COLUMNS.map((id, index) => (
              <MenuItem
                key={id}
                index={index}
                label={columnLabels[index] ?? id}
                checked={columns.includes(index)}
                onSelect={() =>
                  setColumns((current) =>
                    current.includes(index)
                      ? current.filter((value) => value !== index)
                      : [...current, index].sort(),
                  )
                }
              />
            ))}
          </DropdownContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownTrigger render={<Button variant="outline">{m.ui_preview_projects()}</Button>} />
          <DropdownContent>
            <DropdownSearch
              value={query}
              onValueChange={setQuery}
              placeholder={m.ui_preview_search()}
            />
            {matches.map((project, index) => (
              <MenuItem key={project.id} index={index} label={project.name} />
            ))}
            {matches.length === 0 && <DropdownEmpty>{m.ui_preview_no_results()}</DropdownEmpty>}
          </DropdownContent>
        </DropdownMenu>
      </Specimen>
    </PreviewSection>
  )
}

export function CommandMenuSection() {
  const [last, setLast] = useState<string | null>(null)
  const labels: CommandMenuLabels = {
    placeholder: m.ui_preview_command_placeholder(),
    suggestions: m.ui_preview_suggestions(),
    tabs: m.ui_preview_filters(),
    selectHint: m.ui_preview_hint_select(),
    tabsHint: m.ui_preview_hint_tabs(),
    closeHint: m.ui_preview_close(),
  }
  const projects = m.ui_preview_projects()
  const navigation = m.ui_preview_navigation()
  const items: CommandMenuItemData[] = [
    {
      value: 'new',
      label: m.ui_preview_new_project(),
      group: projects,
      shortcut: 'mod+shift+n',
      icon: Folder,
    },
    ...SAMPLE_PROJECTS.slice(0, 3).map((project) => ({
      value: project.id,
      label: project.name,
      description: project.owner,
      group: projects,
    })),
    { value: 'archive', label: m.ui_preview_status_archived(), group: projects, disabled: true },
    { value: 'home', label: m.ui_preview_nav_home(), group: navigation, icon: House },
    {
      value: 'settings',
      label: m.ui_preview_nav_settings(),
      group: navigation,
      icon: Settings,
    },
  ]
  const onSelect = (item: CommandMenuItemData) => setLast(item.label)
  return (
    <PreviewSection
      id="command-menu"
      title="Command Menu"
      description={m.ui_preview_command_desc()}
    >
      <Specimen label={m.ui_preview_inline()} className="block">
        <CommandMenu items={items} labels={labels} onSelect={onSelect}>
          <CommandMenuInput />
          <CommandMenuList>
            <CommandMenuEmpty>{m.ui_preview_no_results()}</CommandMenuEmpty>
          </CommandMenuList>
          <CommandMenuFooter />
        </CommandMenu>
      </Specimen>
      <Specimen label={m.ui_preview_dialog_shortcut()} className="flex-col items-start">
        <CommandMenuDialog title={m.ui_preview_command_title()} shortcut="mod+k">
          <CommandMenu items={items} labels={labels} onSelect={onSelect}>
            <CommandMenuInput />
            <CommandMenuList>
              <CommandMenuEmpty>{m.ui_preview_no_results()}</CommandMenuEmpty>
            </CommandMenuList>
            <CommandMenuFooter />
          </CommandMenu>
        </CommandMenuDialog>
        <p className="text-body text-muted-foreground">{m.ui_preview_command_hint()}</p>
        <p role="status" className="text-body">
          {last ? m.ui_preview_command_ran({ name: last }) : null}
        </p>
      </Specimen>
    </PreviewSection>
  )
}

export function ToastSection() {
  return (
    <>
      {/* 视口固定定位，放在网格之外，避免占用一个展示格 */}
      <Toaster
        labels={{
          // Radix 把 {hotkey} 替换为 F8，原样传给它
          region: m.ui_preview_toast_region({ hotkey: '{hotkey}' }),
          announcement: m.ui_preview_toast_announcement(),
          close: m.ui_preview_close(),
        }}
      />
      <PreviewSection id="toast" title="Toast" description={m.ui_preview_toast_desc()}>
        <Specimen label={m.ui_preview_variants()}>
          <Button
            variant="outline"
            onClick={() =>
              toast(m.ui_preview_toast_saved(), { description: m.ui_preview_toast_saved_desc() })
            }
          >
            {m.ui_preview_default()}
          </Button>
          <Button variant="outline" onClick={() => toast.success(m.ui_preview_toast_success())}>
            success
          </Button>
          <Button variant="outline" onClick={() => toast.error(m.ui_preview_toast_error())}>
            error
          </Button>
        </Specimen>
        <Specimen label={m.ui_preview_with_action()}>
          <Button
            variant="outline"
            onClick={() =>
              toast(m.ui_preview_toast_deleted(), {
                action: { label: m.ui_preview_undo(), onClick: () => {} },
              })
            }
          >
            {m.ui_preview_delete_project()}
          </Button>
          <Button variant="ghost" onClick={() => toast.dismiss()}>
            {m.ui_preview_dismiss_all()}
          </Button>
        </Specimen>
      </PreviewSection>
    </>
  )
}
