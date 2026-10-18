import { Card, CardDescription, CardHeader, CardTitle } from '@product-res/ui'
import { m } from '../../../paraglide/messages.js'
import { Section } from './section.tsx'

const features = [
  { title: m.marketing_feature_auth_title, body: m.marketing_feature_auth_body },
  { title: m.marketing_feature_billing_title, body: m.marketing_feature_billing_body },
  { title: m.marketing_feature_ai_title, body: m.marketing_feature_ai_body },
  { title: m.marketing_feature_i18n_title, body: m.marketing_feature_i18n_body },
  { title: m.marketing_feature_admin_title, body: m.marketing_feature_admin_body },
  { title: m.marketing_feature_content_title, body: m.marketing_feature_content_body },
]

export function Features() {
  return (
    <Section
      id="features"
      title={m.marketing_features_title()}
      subtitle={m.marketing_features_subtitle()}
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((feature) => (
          <Card key={feature.title()}>
            <CardHeader>
              <CardTitle>
                <h3>{feature.title()}</h3>
              </CardTitle>
              <CardDescription>{feature.body()}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
    </Section>
  )
}
