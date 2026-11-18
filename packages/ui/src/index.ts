export { Alert, AlertDescription, AlertTitle } from './components/alert.tsx'
export {
  AlertDialog,
  AlertDialogAction,
  type AlertDialogButtonProps,
  AlertDialogCancel,
  AlertDialogContent,
  type AlertDialogContentProps,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from './components/alert-dialog.tsx'
export {
  Badge,
  type BadgeColor,
  type BadgeProps,
  type BadgeSize,
} from './components/badge.tsx'
export { Button, type ButtonProps, buttonVariants } from './components/button.tsx'
export {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from './components/card.tsx'
export { CHART_COLORS, Chart, type ChartProps } from './components/chart.tsx'
export { Checkbox, type CheckboxProps } from './components/checkbox.tsx'
export {
  Combobox,
  ComboboxChips,
  type ComboboxChipsProps,
  ComboboxContent,
  type ComboboxContentProps,
  ComboboxEmpty,
  type ComboboxEmptyProps,
  ComboboxInput,
  type ComboboxInputProps,
  ComboboxItem,
  type ComboboxItemData,
  type ComboboxItemProps,
  ComboboxList,
  type ComboboxListProps,
  type ComboboxProps,
  type ComboboxValue,
} from './components/combobox.tsx'
export {
  CommandMenu,
  CommandMenuDialog,
  type CommandMenuDialogProps,
  CommandMenuEmpty,
  type CommandMenuEmptyProps,
  CommandMenuFilters,
  type CommandMenuFiltersProps,
  CommandMenuFooter,
  type CommandMenuFooterProps,
  type CommandMenuHint,
  CommandMenuInput,
  type CommandMenuInputProps,
  CommandMenuItem,
  type CommandMenuItemData,
  type CommandMenuItemProps,
  type CommandMenuLabels,
  CommandMenuList,
  type CommandMenuListProps,
  CommandMenuPlatform,
  type CommandMenuProps,
  CommandMenuShortcut,
  type CommandMenuShortcutProps,
  type CommandMenuTab,
  CommandMenuTabs,
  type CommandMenuTabsProps,
} from './components/command-menu.tsx'
// 业务界面组件（tasks 8.6，纯展示、文案无默认值）：CreditEstimate、DailyClaimNotice、EmbeddedChat、
// InsufficientCreditsDialog、LockedFeature、MessageFeedback、SuggestionChips，随 Biome 排序分布在字母序位置
export {
  CreditEstimate,
  type CreditEstimateProps,
} from './components/credit-estimate.tsx'
export {
  type DailyClaimLabels,
  DailyClaimNotice,
  type DailyClaimNoticeProps,
  type DailyClaimStatus,
} from './components/daily-claim-notice.tsx'
export {
  DataTable,
  type DataTableColumn,
  type DataTableFilter,
  type DataTableLabels,
  type DataTablePage,
  type DataTableProps,
  type DetailField,
  DetailList,
} from './components/data-table.tsx'
export {
  Dialog,
  DialogClose,
  type DialogCloseProps,
  DialogContent,
  type DialogContentProps,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  type DialogTriggerProps,
} from './components/dialog.tsx'
export {
  Dropdown,
  DropdownContent,
  type DropdownContentProps,
  DropdownEmpty,
  type DropdownEmptyProps,
  DropdownLabel,
  DropdownMenu,
  type DropdownMenuProps,
  type DropdownProps,
  DropdownSearch,
  type DropdownSearchProps,
  DropdownSeparator,
  DropdownSub,
  DropdownSubContent,
  type DropdownSubContentProps,
  type DropdownSubProps,
  DropdownSubTrigger,
  type DropdownSubTriggerProps,
  DropdownTrigger,
  type DropdownTriggerProps,
  MenuItem,
  type MenuItemProps,
} from './components/dropdown.tsx'
export {
  EmbeddedChat,
  type EmbeddedChatLabels,
  type EmbeddedChatProps,
} from './components/embedded-chat.tsx'
export {
  errorMessages,
  FieldErrors,
  Form,
  SubmitButton,
  type SubmitButtonProps,
  TextField,
  type TextFieldProps,
  useAppForm,
  useFieldContext,
  useFormContext,
  withForm,
} from './components/form.tsx'
export { Input, type InputProps } from './components/input.tsx'
export {
  InsufficientCreditsDialog,
  type InsufficientCreditsDialogProps,
  type InsufficientCreditsLabels,
} from './components/insufficient-credits-dialog.tsx'
export { Label } from './components/label.tsx'
export { LockedFeature, type LockedFeatureProps } from './components/locked-feature.tsx'
export {
  type FeedbackRating,
  MessageFeedback,
  type MessageFeedbackLabels,
  type MessageFeedbackProps,
  type MessageFeedbackReason,
  type MessageFeedbackShareLabels,
  type MessageFeedbackValue,
} from './components/message-feedback.tsx'
export {
  type PdfExportDocument,
  type PdfExporter,
  registerPdfExporter,
} from './components/pdf-exporter.ts'
export {
  Popover,
  PopoverAnchor,
  PopoverClose,
  type PopoverCloseProps,
  PopoverContent,
  type PopoverContentProps,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
  type PopoverTriggerProps,
} from './components/popover.tsx'
export { ScrollArea, type ScrollAreaProps, ScrollBar } from './components/scroll-area.tsx'
export {
  Select,
  SelectContent,
  type SelectContentProps,
  SelectGroup,
  SelectItem,
  type SelectItemProps,
  SelectLabel,
  type SelectProps,
  SelectSeparator,
  SelectTrigger,
  type SelectTriggerProps,
} from './components/select.tsx'
export { Separator } from './components/separator.tsx'
export {
  Sheet,
  SheetClose,
  type SheetCloseProps,
  SheetContent,
  type SheetContentProps,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  type SheetSide,
  SheetTitle,
  SheetTrigger,
  type SheetTriggerProps,
} from './components/sheet.tsx'
export {
  Sidebar,
  type SidebarCollapsible,
  SidebarContent,
  type SidebarContentProps,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  type SidebarGroupActionProps,
  SidebarGroupActions,
  type SidebarGroupActionsProps,
  SidebarGroupContent,
  SidebarGroupLabel,
  type SidebarGroupLabelProps,
  type SidebarGroupProps,
  SidebarHeader,
  SidebarInput,
  type SidebarInputProps,
  SidebarInset,
  type SidebarInsetProps,
  type SidebarLabels,
  SidebarMenu,
  SidebarMenuAction,
  type SidebarMenuActionProps,
  SidebarMenuActions,
  type SidebarMenuActionsProps,
  SidebarMenuBadge,
  type SidebarMenuBadgeProps,
  SidebarMenuButton,
  type SidebarMenuButtonProps,
  SidebarMenuItem,
  type SidebarMenuItemProps,
  type SidebarMenuProps,
  SidebarMenuSkeleton,
  type SidebarMenuSkeletonProps,
  SidebarMenuSub,
  SidebarMenuSubButton,
  type SidebarMenuSubButtonProps,
  SidebarMenuSubItem,
  type SidebarMenuSubItemProps,
  type SidebarMenuSubProps,
  type SidebarProps,
  SidebarProvider,
  type SidebarProviderProps,
  SidebarRail,
  type SidebarRailProps,
  type SidebarSectionProps,
  SidebarSeparator,
  type SidebarSide,
  SidebarTrigger,
  type SidebarTriggerProps,
  type SidebarVariant,
} from './components/sidebar.tsx'
export { SuggestionChips, type SuggestionChipsProps } from './components/suggestion-chips.tsx'
export { Switch, type SwitchProps } from './components/switch.tsx'
export {
  Tabs,
  TabsItem,
  type TabsItemProps,
  TabsPanel,
  type TabsPanelProps,
  type TabsProps,
} from './components/tabs.tsx'
export { Textarea, type TextareaProps } from './components/textarea.tsx'
export {
  THEME_STORAGE_KEY,
  THEMES,
  type Theme,
  ThemeToggle,
  type ThemeToggleProps,
  themeInitScript,
  useTheme,
} from './components/theme.tsx'
export {
  Toaster,
  type ToasterLabels,
  type ToasterPosition,
  type ToasterProps,
} from './components/toast.tsx'
// 命令式 API 来自零依赖的 store，只调用 toast() 的页面不会带上 Toaster 与动效库
export {
  type ToastAction,
  type ToastOptions,
  type ToastVariant,
  toast,
} from './components/toast-store.ts'
export {
  Tooltip,
  TooltipPortalContainer,
  type TooltipProps,
  TooltipProvider,
  type TooltipProviderProps,
  type TooltipSide,
} from './components/tooltip.tsx'
export {
  UI_DENSITIES,
  UI_PRESETS,
  UI_SHAPES,
  type UiDensity,
  type UiPreset,
  UiRoot,
  type UiRootProps,
} from './components/ui-root.tsx'
export {
  ACQUISITION_LABELS,
  type AcquisitionMethod,
  ConfidenceBar,
  GRADE_LABELS,
  type Grade,
  GradeTag,
  gradeOf,
  LEAD_STATUS_LABELS,
  type LeadStatus,
  type Readiness,
  RiskCard,
  type RiskLevel,
  SourceBadge,
  StatCard,
  StatusTag,
  Tag,
  type Tone,
} from './components/workbench.tsx'
// 上下文 hooks 与 Provider 暂不导出（接口随上游月度变化），应用经 UiRoot 配置
export type { IconComponent, IconName } from './lib/icon-context.tsx'
export type { ShapeVariant } from './lib/shape-context.tsx'
export type { SizeVariant } from './lib/size-context.tsx'
export { cn } from './lib/utils.ts'
export { type ShareCardTheme, shareCardThemes } from './share-card-theme.ts'
