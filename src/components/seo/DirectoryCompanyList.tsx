import type { PublicCompany } from "@/lib/seo/catalog";
import { graphUrl } from "@/lib/seo/catalog";
import { slugify } from "@/lib/seo/site";
import { DirectoryLink } from "./DirectoryLink";

export function DirectoryCompanyList({
  companies,
  ranked = false,
  limit
}: {
  companies: PublicCompany[];
  ranked?: boolean;
  limit?: number;
}) {
  const visible = typeof limit === "number" ? companies.slice(0, limit) : companies;

  return (
    <div className="rf-directory-table">
      {visible.map((company, index) => (
        <article className="rf-company-row" key={`${company.node.entityId}-${company.node.batchSlug}`}>
          <div className="rf-company-rank">{ranked ? `#${index + 1}` : String(index + 1).padStart(2, "0")}</div>
          <div className="rf-company-copy">
            <DirectoryLink className="rf-company-name" href={`/companies/${company.slug}`}>{company.node.label}</DirectoryLink>
            {company.node.tagline ? <p className="rf-company-tagline">{company.node.tagline}</p> : null}
            <div className="rf-company-meta">
              <span>
                <DirectoryLink href={`/cohorts/${slugify(company.graph.batch.label)}`}>{company.graph.batch.label}</DirectoryLink>
              </span>
              {company.node.primaryIndustry ? (
                <span><DirectoryLink href={`/industries/${slugify(company.node.primaryIndustry)}`}>{company.node.primaryIndustry}</DirectoryLink></span>
              ) : null}
              <span><DirectoryLink href={graphUrl(company)}>Open graph</DirectoryLink></span>
            </div>
          </div>
          <div className="rf-company-score">
            <strong>{company.node.score}</strong>
            <span>traction score</span>
          </div>
        </article>
      ))}
    </div>
  );
}
